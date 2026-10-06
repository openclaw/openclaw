import { parseStrictNonNegativeInteger } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString as toOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { readAcpSessionMetaForEntry } from "../acp/runtime/session-meta-readonly.js";
import { resolveSessionStorePathForAcp } from "../acp/runtime/session-meta.js";
import {
  buildAgentRunTerminalOutcomeFromLifecycleEvent,
  classifyAgentRunTerminalOutcome,
} from "../agents/agent-run-terminal-outcome.js";
import { formatCliCommand } from "../cli/command-format.js";
import { getRuntimeConfig } from "../config/config.js";
import { listSessionEntriesReadOnly } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { resolveStoredSessionKeyForAgentStore } from "../gateway/session-store-key.js";
import { formatErrorMessage } from "../infra/errors.js";
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

type FollowOutcome = "ERROR" | "SIGINT" | "SIGTERM";

const DEFAULT_TAIL_COUNT = 80;
const SESSION_KEY_PAD = 30;
const EVENT_TYPE_PAD = 16;
const FOLLOW_INTERVAL_MS = 1_000;

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

function safePreview(event: TrajectoryEvent): string {
  const data = event.data;
  switch (event.type) {
    case "session.started":
      return "session started";
    case "context.compiled": {
      const tools = Array.isArray(data?.tools) ? data.tools.length : undefined;
      return tools === undefined ? "context compiled" : `context compiled (${tools} tools)`;
    }
    case "prompt.submitted":
      return "prompt submitted";
    case "prompt.skipped": {
      const reason = toOptionalString(data?.reason);
      return `prompt skipped${reason ? `: ${reason}` : ""}`;
    }
    case "tool.call":
      // Tool arguments may contain secrets or user text; tail output shows only
      // the tool name and a redacted placeholder.
      return `${toolName(data)} {...redacted...}`;
    case "tool.timeout":
      return `${toolName(data)} timeout`;
    case "tool.result":
      return `${toolName(data)} ${resultStatus(data)}`;
    case "model.completed": {
      const model = [event.provider?.trim(), event.modelId?.trim()].filter(Boolean).join("/");
      const status = modelCompletionStatus(data);
      return model ? `${model} ${status}` : status;
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

function selectSessionsToTail(selections: TailSelection[], sessionKey?: string): TailSelection[] {
  if (sessionKey) {
    return selections.filter((selection) => selection.key === sessionKey);
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
  states: SqliteFollowState[],
  runtime: RuntimeEnv,
): Promise<FollowOutcome> {
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

function resolveTailTargetAgent(
  opts: SessionsTailOptions,
  sessionKey: string | undefined,
): string | undefined {
  // Keep explicit blanks for the selector to reject instead of inferring a different owner.
  if (opts.agent !== undefined || opts.store !== undefined || opts.allAgents === true) {
    return opts.agent;
  }
  return sessionKey ? resolveAgentIdFromSessionKey(sessionKey) : undefined;
}

/** Tails recent trajectory events for the selected session(s). */
export async function sessionsTailCommand(
  opts: SessionsTailOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const tailCount =
    opts.tail === undefined ? DEFAULT_TAIL_COUNT : parseStrictNonNegativeInteger(opts.tail);
  if (tailCount == null) {
    runtime.error("--tail must be a non-negative integer, for example --tail 25.");
    runtime.exit(1);
    return;
  }
  const requestedKey = opts.sessionKey?.trim();
  if (opts.sessionKey !== undefined && !requestedKey) {
    runtime.error("--session-key must not be empty. Omit it to tail active sessions.");
    runtime.exit(1);
    return;
  }

  const cfg = getRuntimeConfig();
  const targets = resolveCommandSessionStoreTargets({
    cfg,
    opts: {
      store: opts.store,
      agent: resolveTailTargetAgent(opts, requestedKey),
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
      const sessionId = entry.sessionId?.trim();
      if (sessionId) {
        selections.push({ ...target, entry, key: sessionKey, sessionId });
      }
    }
  }
  const selected = selectSessionsToTail(selections, requestedKey);
  if (selected.length === 0) {
    if (requestedKey) {
      runtime.error(
        `Session not found: ${requestedKey}. Run ${formatCliCommand("openclaw sessions list --all-agents --json")} to choose a valid key.`,
      );
      runtime.exit(1);
    } else {
      runtime.log("No sessions found.");
    }
    return;
  }

  const followStates: SqliteFollowState[] = [];
  for (const selection of selected) {
    const rows = loadSqliteTrajectoryRuntimeEventRowsSync({
      agentId: selection.agentId,
      sessionId: selection.sessionId,
      storePath: selection.storePath,
      tailEvents: Math.max(tailCount, opts.follow ? 1 : 0),
    });
    followStates.push({ selection, lastStorageSeq: rows.at(-1)?.seq ?? -1 });
    renderEvents(tailCount > 0 ? rows.slice(-tailCount).map((row) => row.event) : [], runtime);
  }

  if (opts.follow) {
    const outcome = await followSelections(followStates, runtime);
    runtime.exit(outcome === "ERROR" ? 1 : outcome === "SIGINT" ? 130 : 143);
  }
}
