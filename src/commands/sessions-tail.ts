import {
  asNonNegativeFiniteNumber,
  parseStrictNonNegativeInteger,
} from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString as toOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { readAcpSessionMetaForEntry } from "../acp/runtime/session-meta-readonly.js";
import { resolveSessionStorePathForAcp } from "../acp/runtime/session-meta.js";
import {
  buildAgentRunTerminalOutcomeFromLifecycleEvent,
  classifyAgentRunTerminalOutcome,
} from "../agents/agent-run-terminal-outcome.js";
import { getRuntimeConfig } from "../config/config.js";
import { listSessionEntriesReadOnly } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { resolveStoredSessionKeyForAgentStore } from "../gateway/session-store-key.js";
import { formatErrorMessage } from "../infra/errors.js";
import { formatDurationPrecise } from "../infra/format-time/format-duration.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { loadSqliteTrajectoryRuntimeEventRowsSync } from "../trajectory/runtime-store.sqlite.js";
import type { TrajectoryEvent } from "../trajectory/types.js";
import { resolveCommandSessionStoreTargets } from "./session-store-targets.js";
import { formatTextCell } from "./text-format.js";

type SessionsTailOptions = {
  store?: string;
  agent?: string;
  allAgents?: boolean;
  sessionKey?: string;
  follow?: boolean;
  tail?: string | number;
};

type TailSelection = {
  agentId: string;
  key: string;
  entry: SessionEntry;
  storePath: string;
  sessionId: string;
};

type SqliteFollowState = {
  lastStorageSeq: number;
  selection: TailSelection;
};

type TrajectorySnapshot = {
  events: TrajectoryEvent[];
  maxStorageSeq: number;
};
type FollowOutcome = "ERROR" | "SIGINT" | "SIGTERM";

const DEFAULT_TAIL_COUNT = 80;
const SESSION_KEY_PAD = 30;
const EVENT_TYPE_PAD = 16;
const FOLLOW_INTERVAL_MS = 1_000;

function parseTailCount(value: string | number | undefined): number | null {
  if (value === undefined) {
    return DEFAULT_TAIL_COUNT;
  }
  return parseStrictNonNegativeInteger(value) ?? null;
}

function formatTimestamp(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) {
    return "--:--:--";
  }
  return date.toISOString().slice(11, 19);
}

function toolName(data: Record<string, unknown> | undefined): string {
  return toOptionalString(data?.name) ?? toOptionalString(data?.toolName) ?? "tool";
}

function resultStatus(data: Record<string, unknown> | undefined): string {
  if (data?.success === true) {
    return "ok";
  }
  if (data?.success === false || data?.isError === true) {
    return "error";
  }
  return toOptionalString(data?.status) ?? "done";
}

function modelCompletionStatus(data: Record<string, unknown> | undefined): string {
  const outcome = buildAgentRunTerminalOutcomeFromLifecycleEvent({
    phase: "end",
    data: {
      ...data,
      // Attempt timeouts can also record an abort; retain the owner's timeout attribution.
      stopReason: data?.timedOut === true ? "timeout" : data?.stopReason,
    },
  });
  return {
    success: data?.promptError || data?.promptErrorSource || data?.terminalError ? "error" : "done",
    failure: "error",
    timeout: "timeout",
    cancellation: "aborted",
  }[classifyAgentRunTerminalOutcome(outcome)];
}

const METRIC_NUMBER_FORMAT = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

function countMetric(label: string, value: unknown, suffix = ""): string | undefined {
  const count = asNonNegativeFiniteNumber(value);
  return count === undefined
    ? undefined
    : `${label}=${METRIC_NUMBER_FORMAT.format(count)}${suffix}`;
}

function stringCharsMetric(label: string, value: unknown): string | undefined {
  if (typeof value === "string") {
    return countMetric(label, value.length, "ch");
  }
  const bounded = isRecord(value) ? value : undefined;
  return countMetric(label, bounded?.originalChars, "ch");
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) {
    return `${Math.round(bytes)}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round((bytes / 1024) * 10) / 10}KB`;
  }
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10}MB`;
}

function serializedBytes(value: unknown): number | undefined {
  if (typeof value === "string") {
    return Buffer.byteLength(value, "utf8");
  }
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : Buffer.byteLength(serialized, "utf8");
  } catch {
    return undefined;
  }
}

function resultBytes(data: Record<string, unknown> | undefined): number | undefined {
  const explicit =
    asNonNegativeFiniteNumber(data?.resultBytes) ?? asNonNegativeFiniteNumber(data?.outputBytes);
  if (explicit !== undefined) {
    return explicit;
  }
  return serializedBytes(data?.output ?? data?.contentItems ?? data?.result);
}

function durationMs(data: Record<string, unknown> | undefined): number | undefined {
  const direct = asNonNegativeFiniteNumber(data?.durationMs);
  if (direct !== undefined) {
    return direct;
  }
  const result = isRecord(data?.result) ? data.result : undefined;
  return asNonNegativeFiniteNumber(result?.durationMs);
}

function appendMetrics(base: string, metrics: Array<string | undefined>): string {
  const available = metrics.filter((metric): metric is string => metric !== undefined);
  return available.length > 0 ? `${base} ${available.join(" ")}` : base;
}

function traceMetadataPreview(data: Record<string, unknown> | undefined): string {
  const prompting = isRecord(data?.prompting) ? data.prompting : undefined;
  const report = isRecord(prompting?.systemPromptReport) ? prompting.systemPromptReport : undefined;
  const system = isRecord(report?.systemPrompt) ? report.systemPrompt : undefined;
  const currentTurn = isRecord(report?.currentTurn) ? report.currentTurn : undefined;
  const skillsReport = isRecord(report?.skills) ? report.skills : undefined;
  const toolsReport = isRecord(report?.tools) ? report.tools : undefined;
  const skills = isRecord(data?.skills) ? data.skills : undefined;
  const skillEntries = Array.isArray(skillsReport?.entries)
    ? skillsReport.entries
    : Array.isArray(skills?.entries)
      ? skills.entries
      : undefined;

  return appendMetrics("trace metadata", [
    countMetric("prompt", currentTurn?.promptChars, "ch"),
    countMetric("system", system?.chars, "ch"),
    countMetric("skills", skillEntries?.length),
    countMetric(
      "skillChars",
      asNonNegativeFiniteNumber(skillsReport?.promptChars) ??
        (typeof prompting?.skillsPrompt === "string" ? prompting.skillsPrompt.length : undefined),
      "ch",
    ),
    countMetric(
      "tools",
      Array.isArray(toolsReport?.entries) ? toolsReport.entries.length : undefined,
    ),
    countMetric("schema", toolsReport?.schemaChars, "ch"),
  ]);
}

function modelMetrics(data: Record<string, unknown> | undefined): string[] {
  const promptCache = isRecord(data?.promptCache) ? data.promptCache : undefined;
  const lastCallUsage = isRecord(promptCache?.lastCallUsage)
    ? promptCache.lastCallUsage
    : undefined;
  const usage = isRecord(data?.usage) ? data.usage : undefined;
  const observation = isRecord(promptCache?.observation) ? promptCache.observation : undefined;
  const readUsageCount = (key: string): number | undefined =>
    asNonNegativeFiniteNumber(usage?.[key]) ?? asNonNegativeFiniteNumber(lastCallUsage?.[key]);
  const tokenParts = [
    countMetric("in", readUsageCount("input")),
    countMetric("out", readUsageCount("output")),
    countMetric(
      "cacheR",
      readUsageCount("cacheRead") ?? asNonNegativeFiniteNumber(observation?.cacheRead),
    ),
    countMetric("cacheW", readUsageCount("cacheWrite")),
    countMetric("reason", readUsageCount("reasoningTokens")),
    countMetric("total", readUsageCount("total")),
  ].filter((metric): metric is string => metric !== undefined);
  const retention = toOptionalString(promptCache?.retention);
  const cacheRetention =
    retention === "none" || retention === "short" || retention === "long"
      ? `retention=${retention}`
      : undefined;
  const duration = durationMs(data);
  const startedAt = asNonNegativeFiniteNumber(data?.startedAt);
  const endedAt = asNonNegativeFiniteNumber(data?.endedAt);
  const elapsed =
    duration === undefined &&
    startedAt !== undefined &&
    endedAt !== undefined &&
    endedAt >= startedAt
      ? endedAt - startedAt
      : undefined;

  return [
    tokenParts.length > 0 ? `tokens(${tokenParts.join(" ")})` : undefined,
    cacheRetention,
    observation?.broke === true ? "cacheBroke" : undefined,
    duration === undefined ? undefined : `duration=${formatDurationPrecise(duration)}`,
    elapsed === undefined ? undefined : `elapsed=${formatDurationPrecise(elapsed)}`,
  ].filter((metric): metric is string => metric !== undefined);
}

function safePreview(event: TrajectoryEvent): string {
  const data = event.data;
  switch (event.type) {
    case "session.started":
      return "session started";
    case "trace.metadata":
      return traceMetadataPreview(data);
    case "context.compiled": {
      const tools = Array.isArray(data?.tools) ? data.tools.length : undefined;
      const base = tools === undefined ? "context compiled" : `context compiled (${tools} tools)`;
      return appendMetrics(base, [
        stringCharsMetric("prompt", data?.prompt),
        stringCharsMetric("system", data?.systemPrompt),
      ]);
    }
    case "prompt.submitted":
      return appendMetrics("prompt submitted", [
        stringCharsMetric("prompt", data?.prompt),
        stringCharsMetric("system", data?.systemPrompt),
        countMetric("images", data?.imagesCount),
      ]);
    case "prompt.skipped": {
      const reason = toOptionalString(data?.reason);
      return `prompt skipped${reason ? `: ${reason}` : ""}`;
    }
    case "tool.call":
      // Tool arguments may contain secrets or user text; tail output shows only
      // the tool name and a redacted placeholder.
      return `${toolName(data)} {...redacted...}`;
    case "tool.timeout": {
      const timeoutMs = asNonNegativeFiniteNumber(data?.timeoutMs);
      return appendMetrics(`${toolName(data)} timeout`, [
        timeoutMs === undefined ? undefined : `after=${formatDurationPrecise(timeoutMs)}`,
      ]);
    }
    case "tool.result": {
      const bytes = resultBytes(data);
      const duration = durationMs(data);
      return appendMetrics(`${toolName(data)} ${resultStatus(data)}`, [
        bytes === undefined ? undefined : `result=${formatByteSize(bytes)}`,
        duration === undefined ? undefined : `duration=${formatDurationPrecise(duration)}`,
      ]);
    }
    case "model.completed": {
      const model = [event.provider?.trim(), event.modelId?.trim()].filter(Boolean).join("/");
      const status = modelCompletionStatus(data);
      return appendMetrics(model ? `${model} ${status}` : status, modelMetrics(data));
    }
    case "session.ended":
      return toOptionalString(data?.status) ?? "ended";
    case "trace.truncated":
      return "trajectory truncated";
    default:
      return toOptionalString(data?.status) ?? toOptionalString(data?.name) ?? "";
  }
}

function formatProgressLine(event: TrajectoryEvent): string {
  const sessionKey = event.sessionKey ?? event.sessionId;
  const sessionLabel = formatTextCell(sanitizeTerminalText(sessionKey), SESSION_KEY_PAD);
  const typeLabel = formatTextCell(sanitizeTerminalText(event.type), EVENT_TYPE_PAD);
  const preview = safePreview(event);
  return [formatTimestamp(event.ts), typeLabel, sessionLabel, preview].join(" ").trimEnd();
}

function readTailSnapshot(selection: TailSelection, tailEvents: number): TrajectorySnapshot {
  const rows = loadSqliteTrajectoryRuntimeEventRowsSync({
    agentId: selection.agentId,
    sessionId: selection.sessionId,
    storePath: selection.storePath,
    tailEvents,
  });
  return {
    events: rows.map((row) => row.event),
    maxStorageSeq: rows.at(-1)?.seq ?? -1,
  };
}

function renderEvents(events: TrajectoryEvent[], runtime: RuntimeEnv): void {
  for (const event of events) {
    runtime.log(formatProgressLine(event));
  }
}

function isRunningSession(selection: TailSelection): boolean {
  const cfg = getRuntimeConfig();
  const sessionKey = resolveStoredSessionKeyForAgentStore({
    cfg,
    agentId: selection.agentId,
    sessionKey: selection.key,
  });
  const { agentId } = resolveSessionStorePathForAcp({ cfg, sessionKey });
  const acpMeta = readAcpSessionMetaForEntry({
    cfg,
    sessionKey,
    agentId,
    entry: selection.entry,
  });
  return selection.entry.status === "running" || acpMeta?.state === "running";
}

function compareSelectionsByUpdatedAt(a: TailSelection, b: TailSelection): number {
  return (b.entry.updatedAt ?? 0) - (a.entry.updatedAt ?? 0);
}

function buildTailSelection(params: {
  agentId: string;
  entry: SessionEntry;
  key: string;
  storePath: string;
}): TailSelection | null {
  const sessionId = params.entry.sessionId?.trim();
  return sessionId ? { ...params, sessionId } : null;
}

function selectSessionsToTail(selections: TailSelection[], sessionKey?: string): TailSelection[] {
  const requested = sessionKey?.trim();
  if (requested) {
    return selections.filter((selection) => selection.key === requested);
  }

  const running = selections.filter((selection) => isRunningSession(selection));
  if (running.length > 0) {
    // Without an explicit key, prefer all running sessions so follow mode shows
    // concurrent active work instead of only the newest store entry.
    return running.toSorted(compareSelectionsByUpdatedAt);
  }

  const latest = selections.toSorted(compareSelectionsByUpdatedAt)[0];
  return latest ? [latest] : [];
}

function readNewSqliteFollowEvents(state: SqliteFollowState): TrajectoryEvent[] {
  const rows = loadSqliteTrajectoryRuntimeEventRowsSync({
    agentId: state.selection.agentId,
    afterSeq: state.lastStorageSeq,
    sessionId: state.selection.sessionId,
    storePath: state.selection.storePath,
  });
  if (rows.length === 0) {
    return [];
  }
  state.lastStorageSeq = rows.at(-1)?.seq ?? state.lastStorageSeq;
  return rows.map((row) => row.event);
}

function followSelections(
  selections: TailSelection[],
  runtime: RuntimeEnv,
  initialSnapshots: Map<TailSelection, TrajectorySnapshot>,
): Promise<FollowOutcome> {
  const states = selections.map((selection): SqliteFollowState => {
    const snapshot = initialSnapshots.get(selection);
    return {
      lastStorageSeq: snapshot?.maxStorageSeq ?? -1,
      selection,
    };
  });

  return new Promise((resolve) => {
    let finished = false;
    const interval = setInterval(() => {
      for (const state of states) {
        try {
          renderEvents(readNewSqliteFollowEvents(state), runtime);
        } catch (error) {
          runtime.error(
            `Failed to read trajectory progress for ${state.selection.key}: ${formatErrorMessage(
              error,
            )}`,
          );
          return finish("ERROR");
        }
      }
    }, FOLLOW_INTERVAL_MS);

    const finish = (outcome: FollowOutcome) => {
      if (!finished) {
        finished = true;
        clearInterval(interval);
        process.off("SIGINT", stopSigint);
        process.off("SIGTERM", stopSigterm);
        resolve(outcome);
      }
    };
    const stopSigint = () => finish("SIGINT");
    const stopSigterm = () => finish("SIGTERM");
    process.once("SIGINT", stopSigint);
    process.once("SIGTERM", stopSigterm);
  });
}

function resolveTailTargetAgent(opts: SessionsTailOptions): string | undefined {
  // Keep explicit blanks for the selector to reject instead of inferring a different owner.
  if (opts.agent !== undefined || opts.store !== undefined || opts.allAgents === true) {
    return opts.agent;
  }
  return opts.sessionKey?.trim() ? resolveAgentIdFromSessionKey(opts.sessionKey) : undefined;
}

/** Tails recent trajectory events for the selected session(s). */
export async function sessionsTailCommand(
  opts: SessionsTailOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const tailCount = parseTailCount(opts.tail);
  if (tailCount === null) {
    runtime.error("--tail must be a non-negative integer, for example --tail 25.");
    runtime.exit(1);
    return;
  }

  const cfg = getRuntimeConfig();
  const targets = resolveCommandSessionStoreTargets({
    cfg,
    opts: {
      store: opts.store,
      agent: resolveTailTargetAgent(opts),
      allAgents: opts.allAgents,
    },
  });

  const selections: TailSelection[] = [];
  for (const target of targets) {
    for (const { sessionKey, entry } of listSessionEntriesReadOnly({
      agentId: target.agentId,
      storePath: target.storePath,
      projection: "list",
    })) {
      const selection = buildTailSelection({
        agentId: target.agentId,
        entry,
        key: sessionKey,
        storePath: target.storePath,
      });
      if (selection) {
        selections.push(selection);
      }
    }
  }
  const selected = selectSessionsToTail(selections, opts.sessionKey);
  if (selected.length === 0) {
    const suffix = opts.sessionKey ? ` for ${opts.sessionKey}` : "";
    runtime.log(`No sessions found${suffix}.`);
    return;
  }

  const followSnapshots = new Map<TailSelection, TrajectorySnapshot>();
  for (const selection of selected) {
    const snapshot = readTailSnapshot(selection, Math.max(tailCount, opts.follow ? 1 : 0));
    followSnapshots.set(selection, snapshot);
    renderEvents(tailCount > 0 ? snapshot.events.slice(-tailCount) : [], runtime);
  }

  if (opts.follow) {
    const outcome = await followSelections(selected, runtime, followSnapshots);
    runtime.exit(outcome === "ERROR" ? 1 : outcome === "SIGINT" ? 130 : 143);
  }
}
