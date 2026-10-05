import type { AgentRunTerminalOutcome } from "../agents/agent-run-terminal-outcome.js";
import { captureSessionEntryCurrentRead } from "../config/sessions/session-entry-current-runtime.js";
import type { SessionEntryCurrentCheck } from "../config/sessions/session-entry-current.types.js";
import { withSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { recordSessionStateEventAsync } from "./session-state-events.js";

const log = createSubsystemLogger("sessions/run-terminal-state");

const TERMINAL_SUMMARY_BY_STATUS = {
  ok: "session run completed",
  error: "session run failed",
  timeout: "session run timed out",
} as const;

async function recordSessionRunTerminalState(params: {
  sessionKey: string;
  sessionId: string;
  agentId: string;
  runId: string;
  outcome: AgentRunTerminalOutcome;
  occurredAt?: number;
  assertCurrent: () => void;
  sessionEntryCurrent?: SessionEntryCurrentCheck;
}): Promise<void> {
  const succeeded = params.outcome.status === "ok";
  await recordSessionStateEventAsync(
    {
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      agentId: params.agentId,
      kind: succeeded ? "run_completed" : "run_failed",
      actorType: "system",
      runId: params.runId,
      dedupeKey: `run-terminal:${params.runId}`,
      summary: TERMINAL_SUMMARY_BY_STATUS[params.outcome.status],
      ...(succeeded
        ? {}
        : {
            payload: {
              outcome: params.outcome.status,
              reason: params.outcome.reason,
            },
          }),
      ...(params.occurredAt === undefined ? {} : { occurredAt: params.occurredAt }),
    },
    {
      onlyIfWatched: true,
      assertCurrent: params.assertCurrent,
      sessionEntryCurrent: params.sessionEntryCurrent,
    },
  );
}

/** Record only while the terminal persistence owner's exact session incarnation remains current. */
export async function recordCurrentSessionRunTerminalState(params: {
  sessionKey: string;
  sessionId: string;
  storePath: string;
  agentId: string;
  runId: string;
  outcome: AgentRunTerminalOutcome;
  occurredAt?: number;
  assertCurrent?: () => void;
}): Promise<void> {
  const scope = {
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    storePath: params.storePath,
    clone: false,
  };
  try {
    const current = await withSessionEntryReadOnlyInWorker(
      scope,
      params.assertCurrent ?? (() => {}),
      async (read, owner) => {
        if (!read.ok || read.value?.sessionId !== params.sessionId) {
          return undefined;
        }
        return captureSessionEntryCurrentRead(scope, owner);
      },
    );
    if (!current) {
      return;
    }
    const assertEntryCurrent = (entry: { sessionId: string } | undefined) => {
      if (entry?.sessionId !== params.sessionId) {
        throw new Error("Session terminal signal lost its persisted incarnation");
      }
    };
    const assertCurrent = () => {
      params.assertCurrent?.();
      current.assertSourceCurrent();
      if (current.kind !== "file") {
        assertEntryCurrent(current.readCurrent());
      }
    };
    await recordSessionRunTerminalState({
      ...params,
      assertCurrent,
      ...(current.source
        ? {
            sessionEntryCurrent: {
              source: current.source,
              assertCurrent: assertEntryCurrent,
            },
          }
        : {}),
    });
  } catch (error) {
    log.warn("failed to record watched session terminal state", {
      runId: params.runId,
      sessionKey: params.sessionKey,
      error,
    });
  }
}
