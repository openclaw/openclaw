import crypto from "node:crypto";
import { AGENT_LANE_SUBAGENT } from "../../agents/lanes.js";
import { abortEmbeddedPiRun } from "../../agents/pi-embedded.js";
import type { SubagentRunRecord } from "../../agents/subagent-registry.js";
import {
  clearSubagentRunSteerRestart,
  listSubagentRunsForRequester,
  markSubagentRunTerminated,
  markSubagentRunForSteerRestart,
  replaceSubagentRunAfterSteer,
} from "../../agents/subagent-registry.js";
import { spawnSubagentDirect } from "../../agents/subagent-spawn.js";
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
import { extractTextFromChatContent } from "../../shared/chat-content.js";
import {
  formatDurationCompact,
  formatTokenUsageDisplay,
  truncateLine,
} from "../../shared/subagents-format.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { stopSubagentsForRequester } from "./abort.js";
import type { CommandHandler } from "./commands-types.js";
import { clearSessionQueues } from "./queue.js";
import {
  formatRunLabel,
  formatRunStatus,
  resolveSubagentTargetFromRuns,
  type SubagentTargetResolution,
  sortSubagentRuns,
} from "./subagents-utils.js";

const COMMAND = "/subagents";
const COMMAND_KILL = "/kill";
const COMMAND_STEER = "/steer";
const COMMAND_TELL = "/tell";
const ACTIONS = new Set(["list", "kill", "log", "send", "steer", "info", "spawn", "help"]);
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

function formatSubagentListLine(params: {
  entry: SubagentRunRecord;
  index: number;
  runtimeMs: number;
  sessionEntry?: SessionEntry;
}) {
  const usageText = formatTokenUsageDisplay(params.sessionEntry);
  const label = truncateLine(formatRunLabel(params.entry, { maxLength: 48 }), 48);
  const task = formatTaskPreview(params.entry.task);
  const runtime = formatDurationCompact(params.runtimeMs);
  const status = resolveDisplayStatus(params.entry);
  return `${params.index}. ${label} (${resolveModelDisplay(params.sessionEntry, params.entry.model)}, ${runtime}${usageText ? `, ${usageText}` : ""}) ${status}${task.toLowerCase() !== label.toLowerCase() ? ` - ${task}` : ""}`;
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

function resolveRequesterSessionKey(
  params: Parameters<CommandHandler>[0],
  opts?: { preferCommandTarget?: boolean },
): string | undefined {
  const commandTarget = params.ctx.CommandTargetSessionKey?.trim();
  const commandSession = params.sessionKey?.trim();
  const raw = opts?.preferCommandTarget
    ? commandTarget || commandSession
    : commandSession || commandTarget;
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
  return resolveSubagentTargetFromRuns({
    runs,
    token,
    recentWindowMinutes: RECENT_WINDOW_MINUTES,
    label: (entry) => formatRunLabel(entry),
    errors: {
      missingTarget: "Missing subagent id.",
      invalidIndex: (value) => `Invalid subagent index: ${value}`,
      unknownSession: (value) => `Unknown subagent session: ${value}`,
      ambiguousLabel: (value) => `Ambiguous subagent label: ${value}`,
      ambiguousLabelPrefix: (value) => `Ambiguous subagent label prefix: ${value}`,
      ambiguousRunIdPrefix: (value) => `Ambiguous run id prefix: ${value}`,
      unknownTarget: (value) => `Unknown subagent id: ${value}`,
    },
  });
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
    "- /subagents spawn <agentId> <task> [--model <model>] [--thinking <level>]",
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
};

export function extractMessageText(message: ChatMessage): { role: string; text: string } | null {
  const role = typeof message.role === "string" ? message.role : "";
  const shouldSanitize = role === "assistant";
  const text = extractTextFromChatContent(message.content, {
    sanitizeText: shouldSanitize ? sanitizeTextContent : undefined,
  });
  return text ? { role, text } : null;
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

  const requesterKey = resolveRequesterSessionKey(params, {
    preferCommandTarget: action === "spawn",
  });
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
    const mapRuns = (
      entries: SubagentRunRecord[],
      runtimeMs: (entry: SubagentRunRecord) => number,
    ) =>
      entries.map((entry) => {
        const { entry: sessionEntry } = loadSubagentSessionEntry(
          params,
          entry.childSessionKey,
          storeCache,
        );
        const line = formatSubagentListLine({
          entry,
          index,
          runtimeMs: runtimeMs(entry),
          sessionEntry,
        });
        index += 1;
        return line;
      });
    const activeEntries = sorted.filter((entry) => !entry.endedAt);
    const activeLines = mapRuns(
      activeEntries,
      (entry) => now - (entry.startedAt ?? entry.createdAt),
    );
    const recentEntries = sorted.filter(
      (entry) => !!entry.endedAt && (entry.endedAt ?? 0) >= recentCutoff,
    );
    const recentLines = mapRuns(
      recentEntries,
      (entry) => (entry.endedAt ?? now) - (entry.startedAt ?? entry.createdAt),
    );

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

  if (action === "spawn") {
    const agentId = restTokens[0];
    // Parse remaining tokens: task text with optional --model and --thinking flags.
    const taskParts: string[] = [];
    let model: string | undefined;
    let thinking: string | undefined;
    for (let i = 1; i < restTokens.length; i++) {
      if (restTokens[i] === "--model" && i + 1 < restTokens.length) {
        i += 1;
        model = restTokens[i];
      } else if (restTokens[i] === "--thinking" && i + 1 < restTokens.length) {
        i += 1;
        thinking = restTokens[i];
      } else {
        taskParts.push(restTokens[i]);
      }
    }
    const task = taskParts.join(" ").trim();
    if (!agentId || !task) {
      return {
        shouldContinue: false,
        reply: {
          text: "Usage: /subagents spawn <agentId> <task> [--model <model>] [--thinking <level>]",
        },
      };
    }

    const commandTo = typeof params.command.to === "string" ? params.command.to.trim() : "";
    const originatingTo =
      typeof params.ctx.OriginatingTo === "string" ? params.ctx.OriginatingTo.trim() : "";
    const fallbackTo = typeof params.ctx.To === "string" ? params.ctx.To.trim() : "";
    // OriginatingTo reflects the active conversation target and is safer than
    // command.to for cross-surface command dispatch.
    const normalizedTo = originatingTo || commandTo || fallbackTo || undefined;

    const result = await spawnSubagentDirect(
      { task, agentId, model, thinking, cleanup: "keep", expectsCompletionMessage: true },
      {
        agentSessionKey: requesterKey,
        agentChannel: params.ctx.OriginatingChannel ?? params.command.channel,
        agentAccountId: params.ctx.AccountId,
        agentTo: normalizedTo,
        agentThreadId: params.ctx.MessageThreadId,
        agentGroupId: params.sessionEntry?.groupId ?? null,
        agentGroupChannel: params.sessionEntry?.groupChannel ?? null,
        agentGroupSpace: params.sessionEntry?.space ?? null,
      },
    );
    if (result.status === "accepted") {
      return {
        shouldContinue: false,
        reply: {
          text: `Spawned subagent ${agentId} (session ${result.childSessionKey}, run ${result.runId?.slice(0, 8)}).`,
        },
      };
    }
    return {
      shouldContinue: false,
      reply: { text: `Spawn failed: ${result.error ?? result.status}` },
    };
  }

  return { shouldContinue: false, reply: { text: buildSubagentsHelp() } };
};
