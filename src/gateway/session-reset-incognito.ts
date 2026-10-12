import type { Result } from "@openclaw/normalization-core/result";
import type { ErrorShape } from "../../packages/gateway-protocol/src/index.js";
import { deleteSessionEntryLifecycle, type SessionEntry } from "../config/sessions.js";
import { getSessionActorStorageBinding } from "../config/sessions/session-actor-storage-binding.js";
import {
  captureIncognitoSessionOperation,
  withIncognitoSessionBinding,
} from "../config/sessions/session-incognito-binding.js";
import { withTimeout } from "../infra/fs-safe.js";
import { getInProcessGatewayRequestContext } from "../plugins/runtime/gateway-request-scope.js";
import { SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS } from "../sessions/session-lifecycle-admission.js";
import { unavailableSessionRequest } from "./session-request-error.js";

/** The caller retains the reset lifecycle fence through deletion and its notifications. */
type IncognitoResetParams = {
  key: string;
  agentId: string;
  storePath: string;
  target: { canonicalKey: string; storeKeys: string[] };
  entry: SessionEntry;
  commitGuard: () => void;
  beforeDelete: () => Promise<void>;
};

export async function deleteIncognitoSessionForReset(
  params: IncognitoResetParams,
): Promise<Result<{ deletedSessionId?: string }, ErrorShape>> {
  if (getSessionActorStorageBinding({ ...params, sessionKey: params.target.canonicalKey })) {
    return deleteIncognitoSessionForResetInScope(params);
  }
  const binding = captureIncognitoSessionOperation({
    ...params,
    sessionKey: params.target.canonicalKey,
  });
  const run = () => deleteIncognitoSessionForResetInScope(params);
  return binding
    ? binding.actor.sessions.withSharedState(() =>
        withIncognitoSessionBinding({ ...binding, admissionSignal: undefined }, run),
      )
    : run();
}

async function deleteIncognitoSessionForResetInScope(
  params: IncognitoResetParams,
): Promise<Result<{ deletedSessionId?: string }, ErrorShape>> {
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
        return unavailableSessionRequest(
          `Session ${params.key} terminals are still active; try again in a moment.`,
        );
      }
    }
    await params.beforeDelete();
    const memory = getSessionActorStorageBinding({
      ...params,
      sessionKey: params.target.canonicalKey,
    });
    const deleted = await deleteSessionEntryLifecycle({
      commitGuard: params.commitGuard,
      agentId: params.agentId,
      archiveTranscript: false,
      deleteDeliveryArtifacts: true,
      deleteTranscriptWithoutArchive: true,
      expectedEntry: memory ? undefined : params.entry,
      expectedSessionId: params.entry.sessionId,
      expectedUpdatedAt: memory ? undefined : params.entry.updatedAt,
      storePath: params.storePath,
      target: params.target,
    });
    if (!deleted.deleted) {
      return unavailableSessionRequest(`Session ${params.key} changed before reset. Retry.`);
    }
    return { ok: true, value: { deletedSessionId: deleted.deletedSessionId } };
  } finally {
    terminalDrain?.release();
  }
}
