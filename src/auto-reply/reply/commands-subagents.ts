import crypto from "node:crypto";
import type { SubagentRunRecord } from "../../agents/subagent-registry.js";
import type { CommandHandler } from "./commands-types.js";
import { AGENT_LANE_SUBAGENT } from "../../agents/lanes.js";
import { abortEmbeddedPiRun } from "../../agents/pi-embedded.js";
import {
  listAllSubagentRuns,
  listSubagentRunsForRequester,
} from "../../agents/subagent-registry.js";
import {
  extractAssistantText,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
  sanitizeTextContent,
  stripToolMessages,
} from "../../agents/tools/sessions-helpers.js";
import { getSubtreeLeafFirst } from "../../agents/tools/sessions-lineage.js";
import { loadSessionStore, resolveStorePath, updateSessionStore } from "../../config/sessions.js";
import { callGateway } from "../../gateway/call.js";
import { logVerbose } from "../../globals.js";
import { formatDurationCompact } from "../../infra/format-time/format-duration.ts";
import { formatTimeAgo } from "../../infra/format-time/format-relative.ts";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { stopSubagentsForRequester } from "./abort.js";
import { clearSessionQueues } from "./queue.js";
import { formatRunLabel, formatRunStatus, sortSubagentRuns } from "./subagents-utils.js";

type SubagentTargetResolution = {
  entry?: SubagentRunRecord;
  error?: string;
};

const COMMAND = "/subagents";
const ACTIONS = new Set(["list", "tree", "stop", "log", "send", "info", "help"]);

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

function buildTreeIndexMap(): Map<string, string> {
  const allRuns = listAllSubagentRuns();
  const runByChild = new Map(allRuns.map((r) => [r.childSessionKey, r]));
  const childrenOf = new Map<string, SubagentRunRecord[]>();
  for (const r of allRuns) {
    const list = childrenOf.get(r.requesterSessionKey) ?? [];
    list.push(r);
    childrenOf.set(r.requesterSessionKey, list);
  }
  const roots = sortSubagentRuns(allRuns.filter((r) => !runByChild.has(r.requesterSessionKey)));
  const indexMap = new Map<string, string>();
  const walk = (r: SubagentRunRecord, index: string) => {
    indexMap.set(index, r.childSessionKey);
    const children = sortSubagentRuns(childrenOf.get(r.childSessionKey) ?? []);
    children.forEach((child, i) => walk(child, `${index}.${i + 1}`));
  };
  roots.forEach((root, i) => walk(root, `${i + 1}`));
  return indexMap;
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
  // Check for tree index (e.g. "1.2.1")
  if (/^\d+(\.\d+)+$/.test(trimmed)) {
    const indexMap = buildTreeIndexMap();
    const childKey = indexMap.get(trimmed);
    if (!childKey) {
      return { error: `Invalid tree index: ${trimmed}` };
    }
    const match = runs.find((entry) => entry.childSessionKey === childKey);
    if (!match) {
      // Might be a run from a different requester — search all runs
      const allRuns = listAllSubagentRuns();
      const globalMatch = allRuns.find((entry) => entry.childSessionKey === childKey);
      return globalMatch
        ? { entry: globalMatch }
        : { error: `Tree index ${trimmed} not found in current session.` };
    }
    return { entry: match };
  }
  const sorted = sortSubagentRuns(runs);
  if (/^\d+$/.test(trimmed)) {
    const idx = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(idx) || idx <= 0 || idx > sorted.length) {
      return { error: `Invalid subagent index: ${trimmed}` };
    }
    return { entry: sorted[idx - 1] };
  }
  if (trimmed.includes(":")) {
    const match = runs.find((entry) => entry.childSessionKey === trimmed);
    return match ? { entry: match } : { error: `Unknown subagent session: ${trimmed}` };
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
    "🧭 Subagents",
    "Usage:",
    "- /subagents list",
    "- /subagents tree",
    "- /subagents stop <id|#|all> [--cascade]",
    "- /subagents log <id|#> [limit] [tools]",
    "- /subagents info <id|#>",
    "- /subagents send <id|#> <message>",
    "",
    "Ids: use the list index (#), runId prefix, tree index (1.2.1), or full session key.",
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

function loadSubagentSessionEntry(params: Parameters<CommandHandler>[0], childKey: string) {
  const parsed = parseAgentSessionKey(childKey);
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId: parsed?.agentId });
  const store = loadSessionStore(storePath);
  return { storePath, store, entry: store[childKey] };
}

export const handleSubagentsCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  if (!normalized.startsWith(COMMAND)) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /subagents from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const rest = normalized.slice(COMMAND.length).trim();
  const [actionRaw, ...restTokens] = rest.split(/\s+/).filter(Boolean);
  const action = actionRaw?.toLowerCase() || "list";
  if (!ACTIONS.has(action)) {
    return { shouldContinue: false, reply: { text: buildSubagentsHelp() } };
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
    if (runs.length === 0) {
      return { shouldContinue: false, reply: { text: "🧭 Subagents: none for this session." } };
    }
    const sorted = sortSubagentRuns(runs);
    const active = sorted.filter((entry) => !entry.endedAt);
    const done = sorted.length - active.length;
    const lines = ["🧭 Subagents (current session)", `Active: ${active.length} · Done: ${done}`];
    sorted.forEach((entry, index) => {
      const status = formatRunStatus(entry);
      const label = formatRunLabel(entry);
      const runtime =
        entry.endedAt && entry.startedAt
          ? (formatDurationCompact(entry.endedAt - entry.startedAt) ?? "n/a")
          : formatTimeAgo(Date.now() - (entry.startedAt ?? entry.createdAt), { fallback: "n/a" });
      const runId = entry.runId.slice(0, 8);
      lines.push(
        `${index + 1}) ${status} · ${label} · ${runtime} · run ${runId} · ${entry.childSessionKey}`,
      );
    });
    return { shouldContinue: false, reply: { text: lines.join("\n") } };
  }

  if (action === "tree") {
    const allRuns = listAllSubagentRuns();
    if (allRuns.length === 0) {
      return { shouldContinue: false, reply: { text: "🌳 Subagent Tree: no subagents." } };
    }
    const runByChild = new Map(allRuns.map((r) => [r.childSessionKey, r]));
    const childrenOf = new Map<string, SubagentRunRecord[]>();
    for (const r of allRuns) {
      const list = childrenOf.get(r.requesterSessionKey) ?? [];
      list.push(r);
      childrenOf.set(r.requesterSessionKey, list);
    }
    const roots = sortSubagentRuns(allRuns.filter((r) => !runByChild.has(r.requesterSessionKey)));
    const active = allRuns.filter((r) => !r.endedAt).length;
    const statusIcon = (r: SubagentRunRecord) => {
      if (!r.endedAt) {
        return "🔄";
      }
      if (r.outcome?.status === "error") {
        return "❌";
      }
      if (r.outcome?.status === "timeout") {
        return "⏱️";
      }
      return "✅";
    };
    const runtimeStr = (r: SubagentRunRecord) => {
      const start = typeof r.startedAt === "number" ? r.startedAt : r.createdAt;
      const end = typeof r.endedAt === "number" ? r.endedAt : Date.now();
      return formatDurationCompact(Math.max(0, end - start)) ?? "n/a";
    };
    const lines: string[] = [`🌳 Subagent Tree (${active} active, ${allRuns.length} total)`];
    const treeIndexMap = new Map<string, string>();
    const renderNode = (r: SubagentRunRecord, prefix: string, isLast: boolean, index: string) => {
      const connector = isLast ? "└── " : "├── ";
      const depth = typeof r.depth === "number" ? r.depth : 1;
      const label = formatRunLabel(r, { maxLength: 40 });
      lines.push(
        `${prefix}${connector}${statusIcon(r)} [${index}] ${label} — ${runtimeStr(r)} [d${depth}]`,
      );
      treeIndexMap.set(index, r.childSessionKey);
      const children = sortSubagentRuns(childrenOf.get(r.childSessionKey) ?? []);
      const nextPrefix = prefix + (isLast ? "    " : "│   ");
      children.forEach((child, i) => {
        renderNode(child, nextPrefix, i === children.length - 1, `${index}.${i + 1}`);
      });
    };
    roots.forEach((root, i) => {
      renderNode(root, "", i === roots.length - 1, `${i + 1}`);
    });
    return { shouldContinue: false, reply: { text: lines.join("\n") } };
  }

  if (action === "stop") {
    const target = restTokens[0];
    const hasCascade = restTokens.includes("--cascade");
    if (!target) {
      return {
        shouldContinue: false,
        reply: { text: "⚙️ Usage: /subagents stop <id|#|all> [--cascade]" },
      };
    }
    if (target === "all" || target === "*") {
      const { stopped } = stopSubagentsForRequester({
        cfg: params.cfg,
        requesterSessionKey: requesterKey,
      });
      const label = stopped === 1 ? "subagent" : "subagents";
      return {
        shouldContinue: false,
        reply: { text: `⚙️ Stopped ${stopped} ${label}.` },
      };
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
        reply: { text: "⚙️ Subagent already finished." },
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
        `subagents stop: cleared followups=${cleared.followupCleared} lane=${cleared.laneCleared} keys=${cleared.keys.join(",")}`,
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
    if (hasCascade) {
      const subtreeKeys = getSubtreeLeafFirst(childKey).filter((k) => k !== childKey);
      let cascadeStopped = 0;
      for (const subKey of subtreeKeys) {
        const sub = loadSubagentSessionEntry(params, subKey);
        const subSessionId = sub.entry?.sessionId;
        if (subSessionId) {
          abortEmbeddedPiRun(subSessionId);
        }
        clearSessionQueues([subKey, subSessionId]);
        cascadeStopped++;
      }
      return {
        shouldContinue: false,
        reply: {
          text: `⚙️ Stop requested for ${formatRunLabel(resolved.entry)} + ${cascadeStopped} descendant(s).`,
        },
      };
    }
    return {
      shouldContinue: false,
      reply: { text: `⚙️ Stop requested for ${formatRunLabel(resolved.entry)}.` },
    };
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
      `Status: ${formatRunStatus(run)}`,
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

  if (action === "send") {
    const target = restTokens[0];
    const message = restTokens.slice(1).join(" ").trim();
    if (!target || !message) {
      return {
        shouldContinue: false,
        reply: { text: "✉️ Usage: /subagents send <id|#> <message>" },
      };
    }
    const resolved = resolveSubagentTarget(runs, target);
    if (!resolved.entry) {
      return {
        shouldContinue: false,
        reply: { text: `⚠️ ${resolved.error ?? "Unknown subagent."}` },
      };
    }
    const idempotencyKey = crypto.randomUUID();
    let runId: string = idempotencyKey;
    try {
      const response = await callGateway<{ runId: string }>({
        method: "agent",
        params: {
          message,
          sessionKey: resolved.entry.childSessionKey,
          idempotencyKey,
          deliver: false,
          channel: INTERNAL_MESSAGE_CHANNEL,
          lane: AGENT_LANE_SUBAGENT,
        },
        timeoutMs: 10_000,
      });
      const responseRunId = typeof response?.runId === "string" ? response.runId : undefined;
      if (responseRunId) {
        runId = responseRunId;
      }
    } catch (err) {
      const messageText =
        err instanceof Error ? err.message : typeof err === "string" ? err : "error";
      return { shouldContinue: false, reply: { text: `⚠️ Send failed: ${messageText}` } };
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
