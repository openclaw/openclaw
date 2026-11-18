import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import type { InternalSessionEntry, SessionEntry } from "../../config/sessions.js";
import {
  resolveSessionWorkStartBlock,
  type SessionWorkStartError,
} from "../../config/sessions/session-work-start.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  AGENT_HARNESS_MODEL_RUN_FORBIDDEN_MESSAGE,
  resolveAgentHarnessSessionContextError,
  resolveAgentHarnessSessionIdMismatchError,
} from "../../sessions/agent-harness-session-key.js";
import { respondError } from "../server-methods/response.js";
import type { GatewayRequestHandlerOptions } from "../server-methods/types.js";
import type { loadGatewaySessionEntryReadOnlyInWorker } from "../session-utils-store-worker.js";
import { prepareDeletedAgentSessionCheck } from "../session-utils.js";

export function canPrepareAgentSessionWorktree(
  sessionKey: string | undefined,
  entry: InternalSessionEntry | undefined,
): boolean {
  return Boolean(sessionKey && entry?.pendingWorktree) && entry?.pendingProjectGitUrl === undefined;
}

export function resolveAgentSessionWorkStartBlock(
  sessionKey: string,
  entry: SessionEntry | undefined,
): SessionWorkStartError | undefined {
  return resolveSessionWorkStartBlock(
    sessionKey,
    entry,
    canPrepareAgentSessionWorktree(sessionKey, entry) ? { allowPendingWorkspace: true } : undefined,
  );
}

export function respondDeletedAgentSession(params: {
  cfg: OpenClawConfig;
  canonicalKey: string;
  entry?: SessionEntry | null;
  acpMetadataSessionKey?: string;
  respond: GatewayRequestHandlerOptions["respond"];
  assertCurrent?: () => void;
}): boolean | Promise<boolean> {
  const deletedAgentId = prepareDeletedAgentSessionCheck({
    cfg: params.cfg,
    sessionKey: params.canonicalKey,
    entry: params.entry,
    acpMetadataSessionKey: params.acpMetadataSessionKey,
    assertCurrent: params.assertCurrent,
  });
  const respond = (agentId: string | null) => {
    if (agentId === null) {
      return false;
    }
    respondError(
      params.respond,
      ErrorCodes.INVALID_REQUEST,
      `Agent "${agentId}" no longer exists in configuration`,
    );
    return true;
  };
  return deletedAgentId instanceof Promise
    ? deletedAgentId.then((agentId) => {
        params.assertCurrent?.();
        return respond(agentId);
      })
    : respond(deletedAgentId);
}

export function respondUnavailableAgentSession(params: {
  loaded: Awaited<ReturnType<typeof loadGatewaySessionEntryReadOnlyInWorker>>;
  requestedSessionId?: string;
  isRawModelRun: boolean;
  respond: GatewayRequestHandlerOptions["respond"];
  assertCurrent?: () => void;
}): boolean | Promise<boolean> {
  const { cfg, entry, canonicalKey, legacyKey } = params.loaded;
  const deleted = respondDeletedAgentSession({
    cfg,
    canonicalKey,
    entry,
    acpMetadataSessionKey: legacyKey,
    respond: params.respond,
    assertCurrent: params.assertCurrent,
  });
  const respondUnavailable = (isDeleted: boolean) => {
    if (isDeleted) {
      return true;
    }
    const sessionError =
      resolveAgentHarnessSessionContextError(canonicalKey, entry) ||
      resolveAgentHarnessSessionIdMismatchError(entry, params.requestedSessionId) ||
      (params.isRawModelRun && entry?.modelSelectionLocked === true
        ? AGENT_HARNESS_MODEL_RUN_FORBIDDEN_MESSAGE
        : undefined);
    if (sessionError) {
      respondError(params.respond, ErrorCodes.INVALID_REQUEST, sessionError);
      return true;
    }
    const workStartBlock = resolveAgentSessionWorkStartBlock(canonicalKey, entry);
    if (!workStartBlock) {
      return false;
    }
    // Transient blocks stay retryable so internal callers can tell them from refusals.
    respondError(params.respond, ErrorCodes.INVALID_REQUEST, workStartBlock.message, {
      retryable: workStartBlock.retryable,
    });
    return true;
  };
  return deleted instanceof Promise
    ? deleted.then((isDeleted) => {
        params.assertCurrent?.();
        return respondUnavailable(isDeleted);
      })
    : respondUnavailable(deleted);
}

export function yieldAfterAgentAcceptedAck(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 10);
  });
}
