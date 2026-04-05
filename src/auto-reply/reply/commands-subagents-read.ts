import { countPendingDescendantRunsFromRuns } from "../../agents/subagent-registry-queries.js";
import { subagentRuns } from "../../agents/subagent-registry-memory.js";
import type { SubagentRunRecord } from "../../agents/subagent-registry.types.js";
import { loadSessionStore } from "../../config/sessions/store-load.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { formatTimeAgo } from "../../infra/format-time/format-relative.ts";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import type { CommandHandlerResult, HandleCommandsParams } from "./commands-types.js";
import { formatRunLabel, formatRunStatus, resolveSubagentTargetFromRuns } from "./subagents-utils.js";

const RECENT_WINDOW_MINUTES = 30;

export function stopWithText(text: string): CommandHandlerResult {
  return { shouldContinue: false, reply: { text } };
}

export function resolveDisplayStatus(
  entry: SubagentRunRecord,
  options?: { pendingDescendants?: number },
) {
  const pendingDescendants = Math.max(0, options?.pendingDescendants ?? 0);
  if (pendingDescendants > 0) {
    const childLabel = pendingDescendants === 1 ? "child" : "children";
    return `active (waiting on ${pendingDescendants} ${childLabel})`;
  }
  const status = formatRunStatus(entry);
  return status === "error" ? "failed" : status;
}

function formatTimestamp(valueMs?: number) {
  if (!valueMs || !Number.isFinite(valueMs) || valueMs <= 0) {
    return "n/a";
  }
  return new Date(valueMs).toISOString();
}

export function formatTimestampWithAge(valueMs?: number) {
  if (!valueMs || !Number.isFinite(valueMs) || valueMs <= 0) {
    return "n/a";
  }
  return `${formatTimestamp(valueMs)} (${formatTimeAgo(Date.now() - valueMs, { fallback: "n/a" })})`;
}

export function resolveSubagentEntryForToken(
  runs: SubagentRunRecord[],
  token: string | undefined,
): { entry: SubagentRunRecord } | { reply: CommandHandlerResult } {
  const resolved = resolveSubagentTargetFromRuns({
    runs,
    token,
    recentWindowMinutes: RECENT_WINDOW_MINUTES,
    label: (entry) => formatRunLabel(entry),
    isActive: (entry) =>
      !entry.endedAt || Math.max(0, countPendingDescendantRunsFromRuns(subagentRuns, entry.childSessionKey)) > 0,
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
  if (!resolved.entry) {
    return { reply: stopWithText(`⚠️ ${resolved.error ?? "Unknown subagent."}`) };
  }
  return { entry: resolved.entry };
}

export function buildSubagentsHelp() {
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
    "- /focus <subagent-label|session-key|session-id|session-label>",
    "- /unfocus",
    "- /agents",
    "- /session idle <duration|off>",
    "- /session max-age <duration|off>",
    "- /kill <id|#|all>",
    "- /steer <id|#> <message>",
    "- /tell <id|#> <message>",
    "",
    "Ids: use the list index (#), runId/session prefix, label, or full session key.",
  ].join("\n");
}

export type SessionStoreCache = Map<string, Record<string, SessionEntry>>;

export function loadSubagentSessionEntry(
  params: HandleCommandsParams,
  childKey: string,
  storeCache?: SessionStoreCache,
) {
  const parsed = parseAgentSessionKey(childKey);
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: parsed?.agentId,
  });
  let store = storeCache?.get(storePath);
  if (!store) {
    store = loadSessionStore(storePath);
    storeCache?.set(storePath, store);
  }
  return { storePath, store, entry: store[childKey] };
}
