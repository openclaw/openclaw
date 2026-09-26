import type { Result } from "@openclaw/normalization-core/result";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import { deleteSessionEntryLifecycle, type SessionEntry } from "../config/sessions.js";
import { withTimeout } from "../infra/fs-safe.js";
import { getInProcessGatewayRequestContext } from "../plugins/runtime/gateway-request-scope.js";
import { SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS } from "../sessions/session-lifecycle-admission.js";

/** The caller retains the reset lifecycle fence through deletion and its notifications. */
export async function deleteIncognitoSessionForReset(params: {
  key: string;
  agentId: string;
  storePath: string;
  target: { canonicalKey: string; storeKeys: string[] };
  entry: SessionEntry;
  commitGuard: () => void;
  beforeDelete: () => Promise<void>;
}): Promise<Result<{ deletedSessionId?: string }, ErrorShape>> {
  const terminalDrain =
    getInProcessGatewayRequestContext()?.terminalSessions?.beginAgentSessionDrain({
      kind: "agent",
      agentSessionKey: params.target.canonicalKey,
      agentSessionId: params.entry.sessionId,
      agentId: params.agentId,
    });
  try {
    if (terminalDrain) {
      try {
        await withTimeout(
          terminalDrain.drained,
          SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
          "agent terminal lifecycle drain",
        );
      } catch {
        return {
          ok: false,
          error: errorShape(
            ErrorCodes.UNAVAILABLE,
            `Session ${params.key} terminals are still active; try again in a moment.`,
          ),
        };
      }
    }
    await params.beforeDelete();
    const deleted = await deleteSessionEntryLifecycle({
      commitGuard: params.commitGuard,
      agentId: params.agentId,
      archiveTranscript: false,
      deleteDeliveryArtifacts: true,
      deleteTranscriptWithoutArchive: true,
      expectedEntry: params.entry,
      expectedSessionId: params.entry.sessionId,
      expectedUpdatedAt: params.entry.updatedAt,
      storePath: params.storePath,
      target: params.target,
    });
    if (!deleted.deleted) {
      return {
        ok: false,
        error: errorShape(
          ErrorCodes.UNAVAILABLE,
          `Session ${params.key} changed before reset. Retry.`,
        ),
      };
    }
    return { ok: true, value: { deletedSessionId: deleted.deletedSessionId } };
  } finally {
    terminalDrain?.release();
  }
}
