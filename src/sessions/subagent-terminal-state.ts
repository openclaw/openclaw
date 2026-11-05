import type { AcpSessionControlConstraint } from "../acp/runtime/session-meta-control.types.js";
import { captureRuntimeConfigAsyncReader } from "../config/io.runtime.js";
import type { SessionEntryCurrentCheck } from "../config/sessions/session-entry-current.types.js";
import {
  captureSessionWatcherStorePaths,
  prepareSessionWatcherStorePaths,
} from "../config/sessions/session-store-path.js";
import { recordSessionStateEventAsync } from "./session-state-events.js";
import type { SessionStateEventWrite } from "./session-state-events.worker-contract.js";

type SubagentTerminalStatus = "ok" | "error" | "timeout" | "cancelled";

const SUBAGENT_TERMINAL_SUMMARY: Record<SubagentTerminalStatus, string> = {
  ok: "child run completed",
  error: "child run failed",
  timeout: "child run timed out",
  cancelled: "child run cancelled",
};

type SubagentTerminalState = {
  childSessionKey: string;
  agentId: string;
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
  input: SessionStateEventWrite;
  sessionEntryCurrent?: SessionEntryCurrentCheck;
} {
  const watcherSessionKeys = [params.requesterSessionKey];
  return {
    input: {
      event: {
        sessionKey: params.childSessionKey,
        agentId: params.agentId,
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
  let watcherStorePaths = params.watcherStorePaths;
  if (!watcherStorePaths) {
    await captureRuntimeConfigAsyncReader()();
    watcherStorePaths = (await prepareSessionWatcherStorePaths([params.requesterSessionKey])).paths;
  }
  const prepared = prepareSubagentTerminalState({ ...params, watcherStorePaths });
  await recordSessionStateEventAsync(prepared.input.event, {
    now: prepared.input.now,
    assertCurrent,
    acpControl,
    sessionEntryCurrent: params.sessionEntryCurrent,
  });
}
