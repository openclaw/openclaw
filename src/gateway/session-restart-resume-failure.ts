import type { InternalSessionEntry } from "../config/sessions/types.js";
import { formatErrorMessageWithCode, readErrorName } from "../infra/errors.js";
import {
  sanitizeSessionRunError,
  truncateSessionRunError,
} from "../sessions/session-run-error-format.js";
import { recordGatewaySessionRunFailure } from "../sessions/session-run-error.js";

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
