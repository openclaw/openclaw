import {
  isSessionWorkStartInvalidatedError,
  resolveSessionWorkStartError,
  SessionWorkStartChangedError,
  SessionWorkStartInvalidatedError,
} from "../config/sessions/lifecycle.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { createSessionDiffBaselineCaptureClaim } from "../config/sessions/session-diff-baseline-capture.js";
import type { InternalSessionEntry, SessionDiffBaseline } from "../config/sessions/types.js";
import { logVerbose } from "../globals.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";
import { getOrCreatePromise } from "../shared/lazy-promise.js";

const captureInFlight = resolveGlobalMap<string, Promise<InternalSessionEntry>>(
  Symbol.for("openclaw.sessionDiffBaselineCaptureInFlight"),
  async (captures) => {
    await Promise.allSettled(captures.values());
    captures.clear();
  },
);

export async function ensureSessionDiffBaseline(params: {
  agentId: string;
  cwd: string;
  entry: InternalSessionEntry;
  isNewSession: boolean;
  sessionKey: string;
  storePath: string;
}): Promise<InternalSessionEntry> {
  const { entry, sessionKey, storePath, agentId } = params;
  const captureKey = JSON.stringify([storePath, agentId, sessionKey, entry.sessionId]);
  const pending = captureInFlight.get(captureKey);
  if (pending) {
    return pending;
  }
  const capture = entry.sessionDiffBaselineCapture;
  if (
    entry.execNode ||
    entry.sessionDiffBaseline?.sessionId === entry.sessionId ||
    capture?.status === "unavailable" ||
    (!capture && (!params.isNewSession || entry.createdVia !== "operator"))
  ) {
    return entry;
  }

  return await getOrCreatePromise(
    captureInFlight,
    captureKey,
    async () => {
      let baseline: SessionDiffBaseline | undefined;
      try {
        const { captureSessionDiffBaseline } = await import("./session-diff.js");
        baseline = await captureSessionDiffBaseline({
          cwd: params.cwd,
          sessionId: entry.sessionId,
        });
      } catch (error) {
        if (isSessionWorkStartInvalidatedError(error)) {
          throw error;
        }
        logVerbose(
          `session diff baseline capture failed; continuing without attribution filtering: ${formatErrorMessage(error)}`,
        );
      }

      // New callers share the capture before their first workspace write. An
      // interrupted capture needs no separate durable claim: no work has begun.
      const persisted = await patchSessionEntryCore(
        { agentId, sessionKey, storePath },
        (current) => {
          if (
            current.sessionId !== entry.sessionId ||
            current.sessionDiffBaseline?.sessionId === entry.sessionId ||
            current.sessionDiffBaselineCapture?.status === "unavailable"
          ) {
            return null;
          }
          return baseline
            ? { sessionDiffBaseline: baseline, sessionDiffBaselineCapture: undefined }
            : {
                sessionDiffBaselineCapture: {
                  ...(capture ?? createSessionDiffBaselineCaptureClaim()),
                  status: "unavailable" as const,
                },
              };
        },
        { preserveActivity: true, skipMaintenance: true, workerGuard: {} },
      ).catch((error: unknown) => {
        if (isSessionWorkStartInvalidatedError(error)) {
          throw error;
        }
        logVerbose(
          `session diff baseline settlement failed for ${sessionKey}: ${formatErrorMessage(error)}`,
        );
        throw new SessionWorkStartInvalidatedError(
          `Session "${sessionKey}" could not persist its diff baseline before starting work. Retry.`,
        );
      });
      if (!persisted || persisted.sessionId !== entry.sessionId) {
        throw new SessionWorkStartChangedError(
          resolveSessionWorkStartError(sessionKey, persisted, {
            expectedSessionId: entry.sessionId,
          }) ?? `Session "${sessionKey}" changed while starting work. Retry.`,
        );
      }
      return persisted;
    },
    { evictOnSettled: true },
  );
}
