import type { AcpSessionControlConstraint } from "../acp/runtime/session-meta-control.types.js";
import type { SessionEntryCurrentCheck } from "../config/sessions/session-entry-current.types.js";
import { captureSessionWatcherStorePaths } from "../config/sessions/session-store-path.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { recordSessionStateEventAsync } from "./session-state-events.js";
import type { SessionStateWorkerOperations } from "./session-state-events.worker-contract.js";

type SubagentTerminalStatus = "ok" | "error" | "timeout" | "cancelled";

const SUBAGENT_TERMINAL_SUMMARY: Record<SubagentTerminalStatus, string> = {
  ok: "child run completed",
  error: "child run failed",
  timeout: "child run timed out",
  cancelled: "child run cancelled",
};

type SubagentTerminalState = {
  childSessionKey: string;
  runId: string;
  requesterSessionKey: string;
  outcomeStatus: SubagentTerminalStatus;
  sessionEntryCurrent?: SessionEntryCurrentCheck;
  watcherStorePaths?: Readonly<Record<string, string>>;
};

/** The registry commits this signal with its terminal row, under the same authority. */
export function prepareSubagentTerminalState(
  params: SubagentTerminalState,
  now = Date.now(),
): {
  input: SessionStateWorkerOperations["sessionState.record"]["input"];
  sessionEntryCurrent?: SessionEntryCurrentCheck;
} {
  const watcherSessionKeys = [params.requesterSessionKey];
  return {
    input: {
      event: {
        sessionKey: params.childSessionKey,
        agentId: resolveAgentIdFromSessionKey(params.childSessionKey),
        kind: params.outcomeStatus === "ok" ? "run_completed" : "run_failed",
        actorType: "system",
        runId: params.runId,
        dedupeKey: `run-terminal:${params.runId}`,
        summary: SUBAGENT_TERMINAL_SUMMARY[params.outcomeStatus],
        ...(params.outcomeStatus === "ok" ? {} : { payload: { outcome: params.outcomeStatus } }),
        watcherSessionKeys,
        watcherStorePaths:
          params.watcherStorePaths ?? captureSessionWatcherStorePaths(watcherSessionKeys),
      },
      now,
      sessionEntryCurrentSource: params.sessionEntryCurrent?.source,
    },
    sessionEntryCurrent: params.sessionEntryCurrent,
  };
}

/** ACP terminal projections use the signal owner without a native subagent run row. */
export async function recordSubagentTerminalState(
  params: SubagentTerminalState,
  assertCurrent: () => void,
  acpControl?: AcpSessionControlConstraint,
): Promise<void> {
  const prepared = prepareSubagentTerminalState(params);
  await recordSessionStateEventAsync(prepared.input.event, {
    now: prepared.input.now,
    assertCurrent,
    acpControl,
    sessionEntryCurrent: params.sessionEntryCurrent,
  });
}
