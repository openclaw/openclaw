import type { SessionEventReceipt } from "../auto-reply/reply/session-event-contract.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { formatErrorMessageWithCode, readErrorName } from "../infra/errors.js";
import {
  sanitizeSessionRunError,
  truncateSessionRunError,
} from "../sessions/session-run-error-format.js";
import { recordGatewaySessionRunFailure } from "../sessions/session-run-error.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";

/** A recorded wait with no surviving source ends through its exact lifecycle owner. */
export async function recordRestartYieldFailure(params: {
  sessionKey: string;
  agentId: string;
  entry: InternalSessionEntry;
  signal: AbortSignal;
}): Promise<void> {
  const { entry, signal } = params;
  const runId = entry.lifecycleRunId;
  if (!runId) {
    return;
  }
  const error =
    "The Gateway restarted, but the child completion this run was waiting for can no longer arrive. Inspect the saved child work, then send a new message to continue.";
  await persistGatewaySessionLifecycleEvent({
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    expectedWriter: {
      sessionId: entry.sessionId,
      lifecycleRevision: entry.lifecycleRevision,
      runId,
      requireYielded: true,
    },
    assertCommitAllowed: () => signal.throwIfAborted(),
    event: {
      runId,
      sessionId: entry.sessionId,
      ts: Date.now(),
      data: { phase: "error", error, errorNotice: error },
    },
  });
}

/** Admission can fail before a reply owner exists to record its terminal outcome. */
export async function recordRestartResumeFailure(params: {
  target: { agentId: string; storePath: string; sessionKey: string; env?: NodeJS.ProcessEnv };
  entry: InternalSessionEntry;
  runId?: string;
  admissionStage: string;
  error: unknown;
  signal: AbortSignal;
  log: { warn: (message: string) => void };
}): Promise<void> {
  const { target, entry, runId, admissionStage, error, signal, log } = params;
  const diagnostic = truncateSessionRunError(
    sanitizeSessionRunError(
      `${readErrorName(error) ?? "Error"}: ${formatErrorMessageWithCode(error)}`,
    ),
    512,
  );
  log.warn(
    truncateSessionRunError(
      sanitizeSessionRunError(
        `Skipped restart resume for ${target.sessionKey}: ${diagnostic} ${JSON.stringify({ sessionId: entry.sessionId, runId, admissionStage })}`,
      ),
      2048,
    ),
  );
  try {
    await recordGatewaySessionRunFailure({
      target: {
        ...target,
        sessionId: entry.sessionId,
        expectedOwner: {
          lifecycleRevision: entry.lifecycleRevision,
          activeWriterRunId: entry.activeWriterRunId,
        },
      },
      runId: `restart-resume:${runId ?? `${entry.sessionId}:${entry.updatedAt}`}`,
      error: diagnostic,
      notice:
        `The Gateway restarted, but this run could not resume. ${diagnostic} ` +
        "Resolve this error, then send a new message to continue.",
      assertCommitAllowed: () => signal.throwIfAborted(),
    });
  } catch (noticeError) {
    signal.throwIfAborted();
    // Independently authorized queued inputs still continue if this notice cannot persist.
    log.warn(
      `Restart resume failure notice could not be recorded for ${target.sessionKey}: ${truncateSessionRunError(sanitizeSessionRunError(noticeError), 512)}`,
    );
  }
}

/** Observe the admitted input through completion before releasing its retained authority. */
export async function acceptRestartResumeReceipt(
  receipt: SessionEventReceipt,
  sessionKey: string,
  authority: { release: () => void } | undefined,
  log: { warn: (message: string) => void },
): Promise<void> {
  void receipt.settled
    .then((outcome) => {
      if (outcome.status === "failed") {
        log.warn(
          `Restart resume input failed for ${sessionKey}: ${outcome.error ?? "unknown error"}`,
        );
      }
    })
    .finally(() => authority?.release())
    .catch((error: unknown) => {
      log.warn(`Restart resume input failed for ${sessionKey}: ${String(error)}`);
    });
  const accepted = await receipt.accepted;
  if (!accepted.ok) {
    throw accepted.cause ?? new Error(accepted.error);
  }
}
