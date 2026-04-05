import {
  getLatestSubagentRunByChildSessionKey,
  getSubagentSessionRuntimeMs,
  getSubagentSessionStartedAt,
  listSubagentRunsForController,
} from "../../../agents/subagent-registry-read.js";
import { countPendingDescendantRunsFromRuns } from "../../../agents/subagent-registry-queries.js";
import { subagentRuns } from "../../../agents/subagent-registry-memory.js";
import type { SubagentRunRecord } from "../../../agents/subagent-registry.types.js";
import { resolveModelDisplayName, resolveModelDisplayRef } from "../../../agents/model-selection-display.js";
import { resolveStorePath } from "../../../config/sessions/paths.js";
import { loadSessionStore } from "../../../config/sessions/store-load.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import { parseAgentSessionKey } from "../../../routing/session-key.js";
import {
  formatDurationCompact,
  formatTokenUsageDisplay,
  resolveTotalTokens,
  truncateLine,
} from "../../../shared/subagents-format.js";
import { stopWithText } from "../commands-subagents/core.js";
import type { CommandHandlerResult, HandleCommandsParams } from "../commands-types.js";
import type { SubagentsRunsContext } from "../commands-subagents-types.js";
import { sortSubagentRuns } from "../subagents-utils.js";

const RECENT_WINDOW_MINUTES = 30;
const TASK_MAX_CHARS = 110;

type BuiltListLine = {
  line: string;
  runId: string;
  sessionKey: string;
  label: string;
  task: string;
  status: string;
  pendingDescendants: number;
  runtime: string;
  runtimeMs: number;
  childSessions?: string[];
  model?: string;
  totalTokens?: number;
  startedAt?: number;
  endedAt?: number;
};

function resolveSubagentLabel(entry: SubagentRunRecord, fallback = "subagent") {
  const raw = entry.label?.trim() || entry.task?.trim() || "";
  return raw || fallback;
}

function resolveSessionEntryForKey(params: {
  cfg: HandleCommandsParams["cfg"];
  key: string;
  cache: Map<string, Record<string, SessionEntry>>;
}): SessionEntry | undefined {
  const parsed = parseAgentSessionKey(params.key);
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: parsed?.agentId,
  });
  let store = params.cache.get(storePath);
  if (!store) {
    store = loadSessionStore(storePath);
    params.cache.set(storePath, store);
  }
  return store[params.key];
}

function resolveRunStatus(entry: SubagentRunRecord, pendingDescendants: number) {
  if (pendingDescendants > 0) {
    const childLabel = pendingDescendants === 1 ? "child" : "children";
    return `active (waiting on ${pendingDescendants} ${childLabel})`;
  }
  if (!entry.endedAt) {
    return "running";
  }
  const status = entry.outcome?.status ?? "done";
  return status === "ok" ? "done" : status === "error" ? "failed" : status;
}

function resolveChildSessions(controllerSessionKey: string): string[] {
  return Array.from(
    new Set(
      listSubagentRunsForController(controllerSessionKey)
        .map((run) => run.childSessionKey?.trim())
        .filter((childSessionKey): childSessionKey is string => Boolean(childSessionKey))
        .filter((childSessionKey) => {
          const latest = getLatestSubagentRunByChildSessionKey(childSessionKey);
          const latestControllerSessionKey =
            latest?.controllerSessionKey?.trim() || latest?.requesterSessionKey?.trim();
          return latestControllerSessionKey === controllerSessionKey;
        }),
    ),
  );
}

function buildSubagentListLines(params: {
  cfg: HandleCommandsParams["cfg"];
  runs: SubagentRunRecord[];
  recentMinutes: number;
}): {
  active: BuiltListLine[];
  recent: BuiltListLine[];
} {
  const now = Date.now();
  const recentCutoff = now - params.recentMinutes * 60_000;
  const dedupedRuns: SubagentRunRecord[] = [];
  const seenChildSessionKeys = new Set<string>();
  for (const entry of sortSubagentRuns(params.runs)) {
    if (seenChildSessionKeys.has(entry.childSessionKey)) {
      continue;
    }
    seenChildSessionKeys.add(entry.childSessionKey);
    dedupedRuns.push(entry);
  }

  const cache = new Map<string, Record<string, SessionEntry>>();
  const countPendingDescendants = (sessionKey: string) =>
    Math.max(0, countPendingDescendantRunsFromRuns(subagentRuns, sessionKey));
  let index = 1;

  const buildListEntry = (entry: SubagentRunRecord, runtimeMs: number): BuiltListLine => {
    const sessionEntry = resolveSessionEntryForKey({
      cfg: params.cfg,
      key: entry.childSessionKey,
      cache,
    });
    const pendingDescendants = countPendingDescendants(entry.childSessionKey);
    const status = resolveRunStatus(entry, pendingDescendants);
    const runtime = formatDurationCompact(runtimeMs) ?? "n/a";
    const usageText = formatTokenUsageDisplay(sessionEntry);
    const label = truncateLine(resolveSubagentLabel(entry), 48);
    const task = truncateLine(entry.task.trim(), TASK_MAX_CHARS);
    const line = `${index}. ${label} (${resolveModelDisplayName({
      runtimeProvider:
        typeof sessionEntry?.modelProvider === "string" ? sessionEntry.modelProvider : null,
      runtimeModel: typeof sessionEntry?.model === "string" ? sessionEntry.model : null,
      overrideProvider:
        typeof sessionEntry?.providerOverride === "string" ? sessionEntry.providerOverride : null,
      overrideModel:
        typeof sessionEntry?.modelOverride === "string" ? sessionEntry.modelOverride : null,
      fallbackModel: entry.model,
    })}, ${runtime}${usageText ? `, ${usageText}` : ""}) ${status}${
      task.toLowerCase() !== label.toLowerCase() ? ` - ${task}` : ""
    }`;

    const view: BuiltListLine = {
      line,
      runId: entry.runId,
      sessionKey: entry.childSessionKey,
      label,
      task,
      status,
      pendingDescendants,
      runtime,
      runtimeMs,
      ...(resolveChildSessions(entry.childSessionKey).length > 0
        ? { childSessions: resolveChildSessions(entry.childSessionKey) }
        : {}),
      model: resolveModelDisplayRef({
        runtimeProvider:
          typeof sessionEntry?.modelProvider === "string" ? sessionEntry.modelProvider : null,
        runtimeModel: typeof sessionEntry?.model === "string" ? sessionEntry.model : null,
        overrideProvider:
          typeof sessionEntry?.providerOverride === "string" ? sessionEntry.providerOverride : null,
        overrideModel:
          typeof sessionEntry?.modelOverride === "string" ? sessionEntry.modelOverride : null,
        fallbackModel: entry.model,
      }),
      totalTokens: resolveTotalTokens(sessionEntry),
      startedAt: getSubagentSessionStartedAt(entry),
      ...(entry.endedAt ? { endedAt: entry.endedAt } : {}),
    };
    index += 1;
    return view;
  };

  const isActive = (entry: SubagentRunRecord) =>
    !entry.endedAt || countPendingDescendants(entry.childSessionKey) > 0;

  const active = dedupedRuns
    .filter((entry) => isActive(entry))
    .map((entry) => buildListEntry(entry, getSubagentSessionRuntimeMs(entry, now) ?? 0));

  const recent = dedupedRuns
    .filter(
      (entry) => !isActive(entry) && !!entry.endedAt && (entry.endedAt ?? 0) >= recentCutoff,
    )
    .map((entry) =>
      buildListEntry(entry, getSubagentSessionRuntimeMs(entry, entry.endedAt ?? now) ?? 0),
    );

  return { active, recent };
}

export function handleSubagentsListAction(ctx: SubagentsRunsContext): CommandHandlerResult {
  const { params, runs } = ctx;
  const list = buildSubagentListLines({
    cfg: params.cfg,
    runs,
    recentMinutes: RECENT_WINDOW_MINUTES,
  });

  const lines = ["active subagents:", "-----"];
  if (list.active.length === 0) {
    lines.push("(none)");
  } else {
    lines.push(list.active.map((entry) => entry.line).join("\n"));
  }
  lines.push("", `recent subagents (last ${RECENT_WINDOW_MINUTES}m):`, "-----");
  if (list.recent.length === 0) {
    lines.push("(none)");
  } else {
    lines.push(list.recent.map((entry) => entry.line).join("\n"));
  }

  return stopWithText(lines.join("\n"));
}
