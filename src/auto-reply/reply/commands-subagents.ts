import crypto from "node:crypto";
import type { SubagentRunRecord } from "../../agents/subagent-registry.js";
import type { CommandHandler } from "./commands-types.js";
import { AGENT_LANE_SUBAGENT } from "../../agents/lanes.js";
import { abortEmbeddedPiRun } from "../../agents/pi-embedded.js";
import {
  clearSubagentRunSteerRestart,
  listSubagentRunsForRequester,
  markSubagentRunTerminated,
  markSubagentRunForSteerRestart,
  replaceSubagentRunAfterSteer,
} from "../../agents/subagent-registry.js";
import {
  extractAssistantText,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
  sanitizeTextContent,
  stripToolMessages,
} from "../../agents/tools/sessions-helpers.js";
import {
  type SessionEntry,
  loadSessionStore,
  resolveStorePath,
  updateSessionStore,
} from "../../config/sessions.js";
import { callGateway } from "../../gateway/call.js";
import { logVerbose } from "../../globals.js";
import { formatTimeAgo } from "../../infra/format-time/format-relative.ts";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import {
  formatDurationCompact,
  formatTokenUsageDisplay,
  truncateLine,
} from "../../shared/subagents-format.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { stopSubagentsForRequester } from "./abort.js";
import { clearSessionQueues } from "./queue.js";
import { formatRunLabel, formatRunStatus, sortSubagentRuns } from "./subagents-utils.js";

type SubagentTargetResolution = {
  entry?: SubagentRunRecord;
  error?: string;
};

const COMMAND = "/subagents";
const COMMAND_KILL = "/kill";
const COMMAND_STEER = "/steer";
const COMMAND_TELL = "/tell";
const ACTIONS = new Set(["list", "kill", "log", "send", "steer", "info", "help"]);
const RECENT_WINDOW_MINUTES = 30;
const SUBAGENT_TASK_PREVIEW_MAX = 110;
const STEER_ABORT_SETTLE_TIMEOUT_MS = 5_000;

function compactLine(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function formatTaskPreview(value: string) {
  return truncateLine(compactLine(value), SUBAGENT_TASK_PREVIEW_MAX);
}

function resolveModelDisplay(
  entry?: {
    model?: unknown;
    modelProvider?: unknown;
    modelOverride?: unknown;
    providerOverride?: unknown;
  },
  fallbackModel?: string,
) {
  const model = typeof entry?.model === "string" ? entry.model.trim() : "";
  const provider = typeof entry?.modelProvider === "string" ? entry.modelProvider.trim() : "";
  let combined = model.includes("/") ? model : model && provider ? `${provider}/${model}` : model;
  if (!combined) {
    // Fall back to override fields which are populated at spawn time,
    // before the first run completes and writes model/modelProvider.
    const overrideModel =
      typeof entry?.modelOverride === "string" ? entry.modelOverride.trim() : "";
    const overrideProvider =
      typeof entry?.providerOverride === "string" ? entry.providerOverride.trim() : "";
    combined = overrideModel.includes("/")
      ? overrideModel
      : overrideModel && overrideProvider
        ? `${overrideProvider}/${overrideModel}`
        : overrideModel;
  }
  if (!combined) {
    combined = fallbackModel?.trim() || "";
  }
  if (!combined) {
    return "model n/a";
  }
  const slash = combined.lastIndexOf("/");
  if (slash >= 0 && slash < combined.length - 1) {
    return combined.slice(slash + 1);
  }
  return combined;
}

function resolveDisplayStatus(entry: SubagentRunRecord) {
  const status = formatRunStatus(entry);
  return status === "error" ? "failed" : status;
}

function formatTimestamp(valueMs?: number) {
  if (!valueMs || !Number.isFinite(valueMs) || valueMs <= 0) {
    return "n/a";
  }
  return new Date(valueMs).toISOString();
}

function formatTimestampWithAge(valueMs?: number) {
  if (!valueMs || !Number.isFinite(valueMs) || valueMs <= 0) {
    return "n/a";
  }
  return `${formatTimestamp(valueMs)} (${formatTimeAgo(Date.now() - valueMs, { fallback: "n/a" })})`;
}

function resolveRequesterSessionKey(params: Parameters<CommandHandler>[0]): string | undefined {
  const raw = params.sessionKey?.trim() || params.ctx.CommandTargetSessionKey?.trim();
  if (!raw) {
    return undefined;
  }
  const { mainKey, alias } = resolveMainSessionAlias(params.cfg);
  return resolveInternalSessionKey({ key: raw, alias, mainKey });
}

function resolveSubagentTarget(
  runs: SubagentRunRecord[],
  token: string | undefined,
): SubagentTargetResolution {
  const trimmed = token?.trim();
  if (!trimmed) {
    return { error: "Missing subagent id." };
  }
  if (trimmed === "last") {
    const sorted = sortSubagentRuns(runs);
    return { entry: sorted[0] };
  }
  const sorted = sortSubagentRuns(runs);
  const recentCutoff = Date.now() - RECENT_WINDOW_MINUTES * 60_000;
  const numericOrder = [
    ...sorted.filter((entry) => !entry.endedAt),
    ...sorted.filter((entry) => !!entry.endedAt && (entry.endedAt ?? 0) >= recentCutoff),
  ];
  if (/^\d+$/.test(trimmed)) {
    const idx = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(idx) || idx <= 0 || idx > numericOrder.length) {
      return { error: `Invalid subagent index: ${trimmed}` };
    }
    return { entry: numericOrder[idx - 1] };
  }
  if (trimmed.includes(":")) {
    const match = runs.find((entry) => entry.childSessionKey === trimmed);
    return match ? { entry: match } : { error: `Unknown subagent session: ${trimmed}` };
  }
  const lowered = trimmed.toLowerCase();
  const byLabel = runs.filter((entry) => formatRunLabel(entry).toLowerCase() === lowered);
  if (byLabel.length === 1) {
    return { entry: byLabel[0] };
  }
  if (byLabel.length > 1) {
    return { error: `Ambiguous subagent label: ${trimmed}` };
  }
  const byLabelPrefix = runs.filter((entry) =>
    formatRunLabel(entry).toLowerCase().startsWith(lowered),
  );
  if (byLabelPrefix.length === 1) {
    return { entry: byLabelPrefix[0] };
  }
  if (byLabelPrefix.length > 1) {
    return { error: `Ambiguous subagent label prefix: ${trimmed}` };
  }
  const byRunId = runs.filter((entry) => entry.runId.startsWith(trimmed));
  if (byRunId.length === 1) {
    return { entry: byRunId[0] };
  }
  if (byRunId.length > 1) {
    return { error: `Ambiguous run id prefix: ${trimmed}` };
  }
  return { error: `Unknown subagent id: ${trimmed}` };
}

function buildSubagentsHelp() {
  return [
    "Subagents",
    "Usage:",
    "- /subagents list",
    "- /subagents kill <id|#|all>",
    "- /subagents log <id|#> [limit] [tools]",
    "- /subagents info <id|#>",
    "- /subagents send <id|#> <message>",
    "- /subagents steer <id|#> <message>",
    "- /kill <id|#|all>",
    "- /steer <id|#> <message>",
    "- /tell <id|#> <message>",
    "",
    "Ids: use the list index (#), runId/session prefix, label, or full session key.",
  ].join("\n");
}

type ChatMessage = {
  role?: unknown;
  content?: unknown;
  name?: unknown;
  toolName?: unknown;
};

function normalizeMessageText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

export function extractMessageText(message: ChatMessage): { role: string; text: string } | null {
  const role = typeof message.role === "string" ? message.role : "";
  const shouldSanitize = role === "assistant";
  const content = message.content;
  if (typeof content === "string") {
    const normalized = normalizeMessageText(
      shouldSanitize ? sanitizeTextContent(content) : content,
    );
    return normalized ? { role, text: normalized } : null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const chunks: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    if ((block as { type?: unknown }).type !== "text") {
      continue;
    }
    const text = (block as { text?: unknown }).text;
    if (typeof text === "string") {
      const value = shouldSanitize ? sanitizeTextContent(text) : text;
      if (value.trim()) {
        chunks.push(value);
      }
    }
  }
  const joined = normalizeMessageText(chunks.join(" "));
  return joined ? { role, text: joined } : null;
}

function formatLogLines(messages: ChatMessage[]) {
  const lines: string[] = [];
  for (const msg of messages) {
    const extracted = extractMessageText(msg);
    if (!extracted) {
      continue;
    }
    const label = extracted.role === "assistant" ? "Assistant" : "User";
    lines.push(`${label}: ${extracted.text}`);
  }
  return lines;
}

type SessionStoreCache = Map<string, Record<string, SessionEntry>>;

function loadSubagentSessionEntry(
  params: Parameters<CommandHandler>[0],
  childKey: string,
  storeCache?: SessionStoreCache,
) {
  const parsed = parseAgentSessionKey(childKey);
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId: parsed?.agentId });
  let store = storeCache?.get(storePath);
  if (!store) {
    store = loadSessionStore(storePath);
    storeCache?.set(storePath, store);
  }
  return { storePath, store, entry: store[childKey] };
}

export const handleSubagentsCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  const handledPrefix = normalized.startsWith(COMMAND)
    ? COMMAND
    : normalized.startsWith(COMMAND_KILL)
      ? COMMAND_KILL
      : normalized.startsWith(COMMAND_STEER)
        ? COMMAND_STEER
        : normalized.startsWith(COMMAND_TELL)
          ? COMMAND_TELL
          : null;
  if (!handledPrefix) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring ${handledPrefix} from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const rest = normalized.slice(handledPrefix.length).trim();
  const restTokens = rest.split(/\s+/).filter(Boolean);
  let action = "list";
  if (handledPrefix === COMMAND) {
    const [actionRaw] = restTokens;
    action = actionRaw?.toLowerCase() || "list";
    if (!ACTIONS.has(action)) {
      return { shouldContinue: false, reply: { text: buildSubagentsHelp() } };
    }
    restTokens.splice(0, 1);
  } else if (handledPrefix === COMMAND_KILL) {
    action = "kill";
  } else {
    action = "steer";
  }

  const requesterKey = resolveRequesterSessionKey(params);
  if (!requesterKey) {
    return { shouldContinue: false, reply: { text: "⚠️ Missing session key." } };
  }
  const runs = listSubagentRunsForRequester(requesterKey);

  if (action === "help") {
    return { shouldContinue: false, reply: { text: buildSubagentsHelp() } };
  }

  if (action === "list") {
    const sorted = sortSubagentRuns(runs);
    const now = Date.now();
    const recentCutoff = now - RECENT_WINDOW_MINUTES * 60_000;
    const storeCache: SessionStoreCache = new Map();
    let index = 1;
    const activeLines = sorted
      .filter((entry) => !entry.endedAt)
      .map((entry) => {
        const { entry: sessionEntry } = loadSubagentSessionEntry(
          params,
          entry.childSessionKey,
          storeCache,
        );
        const usageText = formatTokenUsageDisplay(sessionEntry);
        const label = truncateLine(formatRunLabel(entry, { maxLength: 48 }), 48);
        const task = formatTaskPreview(entry.task);
        const runtime = formatDurationCompact(now - (entry.startedAt ?? entry.createdAt));
        const status = resolveDisplayStatus(entry);
        const line = `${index}. ${label} (${resolveModelDisplay(sessionEntry, entry.model)}, ${runtime}${usageText ? `, ${usageText}` : ""}) ${status}${task.toLowerCase() !== label.toLowerCase() ? ` - ${task}` : ""}`;
        index += 1;
        return line;
      });
    const recentLines = sorted
      .filter((entry) => !!entry.endedAt && (entry.endedAt ?? 0) >= recentCutoff)
      .map((entry) => {
        const { entry: sessionEntry } = loadSubagentSessionEntry(
          params,
          entry.childSessionKey,
          storeCache,
        );
        const usageText = formatTokenUsageDisplay(sessionEntry);
        const label = truncateLine(formatRunLabel(entry, { maxLength: 48 }), 48);
        const task = formatTaskPreview(entry.task);
        const runtime = formatDurationCompact(
          (entry.endedAt ?? now) - (entry.startedAt ?? entry.createdAt),
        );
        const status = resolveDisplayStatus(entry);
        const line = `${index}. ${label} (${resolveModelDisplay(sessionEntry, entry.model)}, ${runtime}${usageText ? `, ${usageText}` : ""}) ${status}${task.toLowerCase() !== label.toLowerCase() ? ` - ${task}` : ""}`;
        index += 1;
        return line;
      });

    const lines = ["active subagents:", "-----"];
    if (activeLines.length === 0) {
      lines.push("(none)");
    } else {
      lines.push(activeLines.join("\n"));
    }
    lines.push("", `recent subagents (last ${RECENT_WINDOW_MINUTES}m):`, "-----");
    if (recentLines.length === 0) {
      lines.push("(none)");
    } else {
      lines.push(recentLines.join("\n"));
    }
    return { shouldContinue: false, reply: { text: lines.join("\n") } };
  }

  if (action === "kill") {
    const target = restTokens[0];
    if (!target) {
      return {
        shouldContinue: false,
        reply: {
          text:
            handledPrefix === COMMAND
              ? "Usage: /subagents kill <id|#|all>"
              : "Usage: /kill <id|#|all>",
        },
      };
    }
    if (target === "all" || target === "*") {
      stopSubagentsForRequester({
        cfg: params.cfg,
        requesterSessionKey: requesterKey,
      });
      return { shouldContinue: false };
    }
    const resolved = resolveSubagentTarget(runs, target);
    if (!resolved.entry) {
      return {
        shouldContinue: false,
        reply: { text: `⚠️ ${resolved.error ?? "Unknown subagent."}` },
      };
    }
    if (resolved.entry.endedAt) {
      return {
        shouldContinue: false,
        reply: { text: `${formatRunLabel(resolved.entry)} is already finished.` },
      };
    }

    const childKey = resolved.entry.childSessionKey;
    const { storePath, store, entry } = loadSubagentSessionEntry(params, childKey);
    const sessionId = entry?.sessionId;
    if (sessionId) {
      abortEmbeddedPiRun(sessionId);
    }
    const cleared = clearSessionQueues([childKey, sessionId]);
    if (cleared.followupCleared > 0 || cleared.laneCleared > 0) {
      logVerbose(
        `subagents kill: cleared followups=${cleared.followupCleared} lane=${cleared.laneCleared} keys=${cleared.keys.join(",")}`,
      );
    }
    if (entry) {
      entry.abortedLastRun = true;
      entry.updatedAt = Date.now();
      store[childKey] = entry;
      await updateSessionStore(storePath, (nextStore) => {
        nextStore[childKey] = entry;
      });
    }
    markSubagentRunTerminated({
      runId: resolved.entry.runId,
      childSessionKey: childKey,
      reason: "killed",
    });
    // Cascade: also stop any sub-sub-agents spawned by this child.
    stopSubagentsForRequester({
      cfg: params.cfg,
      requesterSessionKey: childKey,
    });
    return { shouldContinue: false };
  }

  if (action === "info") {
    const target = restTokens[0];
    if (!target) {
      return { shouldContinue: false, reply: { text: "ℹ️ Usage: /subagents info <id|#>" } };
    }
    const resolved = resolveSubagentTarget(runs, target);
    if (!resolved.entry) {
      return {
        shouldContinue: false,
        reply: { text: `⚠️ ${resolved.error ?? "Unknown subagent."}` },
      };
    }
    const run = resolved.entry;
    const { entry: sessionEntry } = loadSubagentSessionEntry(params, run.childSessionKey);
    const runtime =
      run.startedAt && Number.isFinite(run.startedAt)
        ? (formatDurationCompact((run.endedAt ?? Date.now()) - run.startedAt) ?? "n/a")
        : "n/a";
    const outcome = run.outcome
      ? `${run.outcome.status}${run.outcome.error ? ` (${run.outcome.error})` : ""}`
      : "n/a";
    const lines = [
      "ℹ️ Subagent info",
      `Status: ${resolveDisplayStatus(run)}`,
      `Label: ${formatRunLabel(run)}`,
      `Task: ${run.task}`,
      `Run: ${run.runId}`,
      `Session: ${run.childSessionKey}`,
      `SessionId: ${sessionEntry?.sessionId ?? "n/a"}`,
      `Transcript: ${sessionEntry?.sessionFile ?? "n/a"}`,
      `Runtime: ${runtime}`,
      `Created: ${formatTimestampWithAge(run.createdAt)}`,
      `Started: ${formatTimestampWithAge(run.startedAt)}`,
      `Ended: ${formatTimestampWithAge(run.endedAt)}`,
      `Cleanup: ${run.cleanup}`,
      run.archiveAtMs ? `Archive: ${formatTimestampWithAge(run.archiveAtMs)}` : undefined,
      run.cleanupHandled ? "Cleanup handled: yes" : undefined,
      `Outcome: ${outcome}`,
    ].filter(Boolean);
    return { shouldContinue: false, reply: { text: lines.join("\n") } };
  }

  if (action === "log") {
    const target = restTokens[0];
    if (!target) {
      return { shouldContinue: false, reply: { text: "📜 Usage: /subagents log <id|#> [limit]" } };
    }
    const includeTools = restTokens.some((token) => token.toLowerCase() === "tools");
    const limitToken = restTokens.find((token) => /^\d+$/.test(token));
    const limit = limitToken ? Math.min(200, Math.max(1, Number.parseInt(limitToken, 10))) : 20;
    const resolved = resolveSubagentTarget(runs, target);
    if (!resolved.entry) {
      return {
        shouldContinue: false,
        reply: { text: `⚠️ ${resolved.error ?? "Unknown subagent."}` },
      };
    }
    const history = await callGateway<{ messages: Array<unknown> }>({
      method: "chat.history",
      params: { sessionKey: resolved.entry.childSessionKey, limit },
    });
    const rawMessages = Array.isArray(history?.messages) ? history.messages : [];
    const filtered = includeTools ? rawMessages : stripToolMessages(rawMessages);
    const lines = formatLogLines(filtered as ChatMessage[]);
    const header = `📜 Subagent log: ${formatRunLabel(resolved.entry)}`;
    if (lines.length === 0) {
      return { shouldContinue: false, reply: { text: `${header}\n(no messages)` } };
    }
    return { shouldContinue: false, reply: { text: [header, ...lines].join("\n") } };
  }

  if (action === "send" || action === "steer") {
    const steerRequested = action === "steer";
    const target = restTokens[0];
    const message = restTokens.slice(1).join(" ").trim();
    if (!target || !message) {
      return {
        shouldContinue: false,
        reply: {
          text: steerRequested
            ? handledPrefix === COMMAND
              ? "Usage: /subagents steer <id|#> <message>"
              : `Usage: ${handledPrefix} <id|#> <message>`
            : "Usage: /subagents send <id|#> <message>",
        },
      };
    }
    const resolved = resolveSubagentTarget(runs, target);
    if (!resolved.entry) {
      return {
        shouldContinue: false,
        reply: { text: `⚠️ ${resolved.error ?? "Unknown subagent."}` },
      };
    }
    if (steerRequested && resolved.entry.endedAt) {
      return {
        shouldContinue: false,
        reply: { text: `${formatRunLabel(resolved.entry)} is already finished.` },
      };
    }
    const { entry: targetSessionEntry } = loadSubagentSessionEntry(
      params,
      resolved.entry.childSessionKey,
    );
    const targetSessionId =
      typeof targetSessionEntry?.sessionId === "string" && targetSessionEntry.sessionId.trim()
        ? targetSessionEntry.sessionId.trim()
        : undefined;

    if (steerRequested) {
      // Suppress stale announce before interrupting the in-flight run.
      markSubagentRunForSteerRestart(resolved.entry.runId);

      // Force an immediate interruption and make steer the next run.
      if (targetSessionId) {
        abortEmbeddedPiRun(targetSessionId);
      }
      const cleared = clearSessionQueues([resolved.entry.childSessionKey, targetSessionId]);
      if (cleared.followupCleared > 0 || cleared.laneCleared > 0) {
        logVerbose(
          `subagents steer: cleared followups=${cleared.followupCleared} lane=${cleared.laneCleared} keys=${cleared.keys.join(",")}`,
        );
      }

      // Best effort: wait for the interrupted run to settle so the steer
      // message is appended on the existing conversation state.
      try {
        await callGateway({
          method: "agent.wait",
          params: {
            runId: resolved.entry.runId,
            timeoutMs: STEER_ABORT_SETTLE_TIMEOUT_MS,
          },
          timeoutMs: STEER_ABORT_SETTLE_TIMEOUT_MS + 2_000,
        });
      } catch {
        // Continue even if wait fails; steer should still be attempted.
      }
    }

    const idempotencyKey = crypto.randomUUID();
    let runId: string = idempotencyKey;
    try {
      const response = await callGateway<{ runId: string }>({
        method: "agent",
        params: {
          message,
          sessionKey: resolved.entry.childSessionKey,
          sessionId: targetSessionId,
          idempotencyKey,
          deliver: false,
          channel: INTERNAL_MESSAGE_CHANNEL,
          lane: AGENT_LANE_SUBAGENT,
          timeout: 0,
        },
        timeoutMs: 10_000,
      });
      const responseRunId = typeof response?.runId === "string" ? response.runId : undefined;
      if (responseRunId) {
        runId = responseRunId;
      }
    } catch (err) {
      if (steerRequested) {
        // Replacement launch failed; restore announce behavior for the
        // original run so completion is not silently suppressed.
        clearSubagentRunSteerRestart(resolved.entry.runId);
      }
      const messageText =
        err instanceof Error ? err.message : typeof err === "string" ? err : "error";
      return { shouldContinue: false, reply: { text: `send failed: ${messageText}` } };
    }

    if (steerRequested) {
      replaceSubagentRunAfterSteer({
        previousRunId: resolved.entry.runId,
        nextRunId: runId,
        fallback: resolved.entry,
        runTimeoutSeconds: resolved.entry.runTimeoutSeconds ?? 0,
      });
      return {
        shouldContinue: false,
        reply: {
          text: `steered ${formatRunLabel(resolved.entry)} (run ${runId.slice(0, 8)}).`,
        },
      };
    }

    const waitMs = 30_000;
    const wait = await callGateway<{ status?: string; error?: string }>({
      method: "agent.wait",
      params: { runId, timeoutMs: waitMs },
      timeoutMs: waitMs + 2000,
    });
    if (wait?.status === "timeout") {
      return {
        shouldContinue: false,
        reply: { text: `⏳ Subagent still running (run ${runId.slice(0, 8)}).` },
      };
    }
    if (wait?.status === "error") {
      const waitError = typeof wait.error === "string" ? wait.error : "unknown error";
      return {
        shouldContinue: false,
        reply: {
          text: `⚠️ Subagent error: ${waitError} (run ${runId.slice(0, 8)}).`,
        },
      };
    }

    const history = await callGateway<{ messages: Array<unknown> }>({
      method: "chat.history",
      params: { sessionKey: resolved.entry.childSessionKey, limit: 50 },
    });
    const filtered = stripToolMessages(Array.isArray(history?.messages) ? history.messages : []);
    const last = filtered.length > 0 ? filtered[filtered.length - 1] : undefined;
    const replyText = last ? extractAssistantText(last) : undefined;
    return {
      shouldContinue: false,
      reply: {
        text:
          replyText ?? `✅ Sent to ${formatRunLabel(resolved.entry)} (run ${runId.slice(0, 8)}).`,
      },
    };
  }

  return { shouldContinue: false, reply: { text: buildSubagentsHelp() } };
};
