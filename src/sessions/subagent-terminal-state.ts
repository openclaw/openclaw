import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { recordSessionStateEventAsync } from "./session-state-events.js";

type SubagentTerminalStatus = "ok" | "error" | "timeout" | "cancelled";

const SUBAGENT_TERMINAL_SUMMARY: Record<SubagentTerminalStatus, string> = {
  ok: "child run completed",
  error: "child run failed",
  timeout: "child run timed out",
  cancelled: "child run cancelled",
};

/** Project an already-normalized subagent terminal outcome into the signal log. */
export async function recordSubagentTerminalState(
  params: {
    childSessionKey: string;
    runId: string;
    requesterSessionKey: string;
    outcomeStatus: SubagentTerminalStatus;
  },
  assertCurrent: () => void,
): Promise<void> {
  // Non-ok outcomes share run_failed; the precise status survives in payload.
  await recordSessionStateEventAsync(
    {
      sessionKey: params.childSessionKey,
      agentId: resolveAgentIdFromSessionKey(params.childSessionKey),
      kind: params.outcomeStatus === "ok" ? "run_completed" : "run_failed",
      actorType: "system",
      runId: params.runId,
      dedupeKey: `run-terminal:${params.runId}`,
      summary: SUBAGENT_TERMINAL_SUMMARY[params.outcomeStatus],
      ...(params.outcomeStatus === "ok" ? {} : { payload: { outcome: params.outcomeStatus } }),
      watcherSessionKeys: [params.requesterSessionKey],
    },
    { assertCurrent },
  );
}
