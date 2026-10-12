import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isSessionWorkStartInvalidatedError } from "../../config/sessions/lifecycle.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { ensureSessionDiffBaseline } from "../../sessions/session-diff-baseline.js";
import type { SessionInitResult } from "./session-init.types.js";

type ReplySessionDiffBaselineParams = {
  agentId: string;
  workspaceDir: string;
  sessionState: Pick<
    SessionInitResult,
    "sessionEntry" | "sessionEntryHandle" | "isNewSession" | "sessionKey" | "storePath"
  >;
};

export type ReplyDiffBaseline = {
  start(
    params: ReplySessionDiffBaselineParams,
    trace: (name: string, run: () => Promise<void>) => Promise<void>,
  ): (() => Promise<void>) | undefined;
};

export async function withReplySessionDiffBaseline<T>(
  run: (baseline: ReplyDiffBaseline) => Promise<T>,
): Promise<T> {
  let capture: Promise<void> | undefined;
  try {
    return await run({
      start(params, trace) {
        const { sessionEntry, isNewSession } = params.sessionState;
        const pending = trace("reply.capture_session_diff_baseline", () =>
          prepareReplySessionDiffBaseline(params),
        ).catch((error: unknown) => {
          if (isSessionWorkStartInvalidatedError(error)) {
            throw error;
          }
          logVerbose(
            `session diff baseline capture failed; continuing without attribution filtering: ${formatErrorMessage(error)}`,
          );
        });
        capture = pending;
        // Tools and final cleanup observe failures after concurrent model preparation.
        void pending.catch(() => {});
        return !sessionEntry.execNode &&
          (sessionEntry.sessionDiffBaselineCapture?.status === "pending" ||
            (isNewSession &&
              sessionEntry.createdVia === "operator" &&
              sessionEntry.sessionDiffBaseline?.sessionId !== sessionEntry.sessionId))
          ? () => pending
          : undefined;
      },
    });
  } finally {
    await capture;
  }
}

async function prepareReplySessionDiffBaseline(
  params: ReplySessionDiffBaselineParams,
): Promise<void> {
  const { sessionState } = params;
  const entry = await ensureSessionDiffBaseline({
    agentId: params.agentId,
    cwd:
      normalizeOptionalString(sessionState.sessionEntry.spawnedCwd) ??
      normalizeOptionalString(sessionState.sessionEntry.spawnedWorkspaceDir) ??
      params.workspaceDir,
    entry: sessionState.sessionEntry,
    isNewSession: sessionState.isNewSession,
    sessionKey: sessionState.sessionKey,
    storePath: sessionState.storePath,
  });
  const current = sessionState.sessionEntryHandle.getCurrent() ?? sessionState.sessionEntry;
  if (current.sessionId === entry.sessionId) {
    const next = {
      ...current,
      sessionDiffBaseline: entry.sessionDiffBaseline,
      sessionDiffBaselineCapture: entry.sessionDiffBaselineCapture,
    };
    sessionState.sessionEntry = next;
    sessionState.sessionEntryHandle.replaceCurrent(next);
  }
}
