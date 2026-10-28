import { err, ok, type Result } from "@openclaw/normalization-core/result";
import {
  ErrorCodes,
  errorShape,
  type SessionsCreateParams,
  type ErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  prepareSessionCreationOperation,
  SessionCreationOperationError,
  readSessionCreationOperationError,
} from "../../config/sessions/session-creation-operation.js";
import { sessionEntryForkedFromParent } from "../../config/sessions/session-entry-lineage.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import type {
  CreateGatewaySessionResult,
  PreparedGatewaySessionLifecycle,
} from "../session-create-service.types.js";
import { resolveSessionCreateAgentId } from "../session-request-agent.js";
import { isFreshChatSendStarted } from "./session-create-initial-turn.js";

/** Validate durable intent separately from the transport's in-memory replay cache. */
export function prepareDurableSessionCreate(
  params: SessionsCreateParams,
  profileId: string | undefined,
  requiredProfile: string | undefined,
  config: OpenClawConfig,
): Result<ReturnType<typeof prepareSessionCreationOperation> | undefined, ErrorShape> {
  if (
    params.purpose &&
    (!params.creationOperationId ||
      !params.sessionId ||
      Boolean(params.repository) !== (params.purpose === "coding") ||
      !requiredProfile ||
      !config.cloudWorkers?.profiles?.[requiredProfile])
  ) {
    return err(
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Worker creation requires a durable operation, physical UUID, and configured required worker profile; coding requires repository and investigation requires an empty workspace.",
      ),
    );
  }
  if (params.creationOperationId === undefined && params.sessionId === undefined) {
    return ok(undefined);
  }
  const allowed = new Set([
    "creationOperationId",
    "sessionId",
    "agentId",
    "label",
    "idempotencyKey",
    "purpose",
    "repository",
  ]);
  if (
    Object.keys(params).some((key) => !allowed.has(key)) ||
    !params.creationOperationId ||
    !params.sessionId ||
    !params.agentId ||
    !profileId ||
    Boolean(params.repository) !== (params.purpose === "coding")
  ) {
    return err(
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Durable creation requires a verified profile, explicit default agent ID, operation ID and physical UUID, with empty-session arguments or a worker purpose and its repository selection only.",
      ),
    );
  }
  const agentError = durableSessionCreateAgentError(params, config);
  if (agentError) {
    return err(agentError);
  }
  try {
    const { idempotencyKey: _transportId, ...immutable } = params;
    return ok(
      prepareSessionCreationOperation(
        profileId,
        params.creationOperationId,
        params.sessionId,
        immutable,
        Date.now(),
      ),
    );
  } catch (error) {
    if (!(error instanceof SessionCreationOperationError)) {
      throw error;
    }
    return err(
      errorShape(ErrorCodes.INVALID_REQUEST, error.message, { details: { reason: error.reason } }),
    );
  }
}

export function durableSessionCreateAgentError(
  params: SessionsCreateParams,
  config: OpenClawConfig,
): ErrorShape | undefined {
  const selected = resolveSessionCreateAgentId(config, {});
  // Reuse creation's existing default owner, not the unrelated system-agent role.
  return !selected.ok ||
    !params.agentId ||
    params.agentId !== normalizeAgentId(params.agentId) ||
    params.agentId !== selected.agentId
    ? errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Durable creation is restricted to the configured default agent.",
      )
    : undefined;
}

export function sessionCreationOperationErrorShape(error: unknown): ErrorShape | undefined {
  const failure = readSessionCreationOperationError(error);
  return failure
    ? errorShape(ErrorCodes.INVALID_REQUEST, failure.message, {
        details: { reason: failure.reason },
      })
    : undefined;
}
/** Transport presentation combines committed session facts with its initial-turn outcome. */
export function projectSessionCreateResponse(
  created: Extract<CreateGatewaySessionResult, { ok: true }>,
  params: {
    lifecycle?: PreparedGatewaySessionLifecycle;
    runPayload?: Record<string, unknown>;
    runError: unknown;
    runMeta?: Record<string, unknown>;
    publicRead: boolean;
    creationOperationId?: string;
    creationReplayed: boolean;
  },
) {
  const worktree = params.lifecycle?.worktree
    ? {
        id: params.lifecycle.worktree.id,
        path: params.lifecycle.sessionRoot,
        branch: params.lifecycle.worktree.branch,
      }
    : undefined;
  const runError =
    created.postCommit.status === "failed"
      ? errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(created.postCommit.error))
      : params.runError;
  const entry = sessionEntryForkedFromParent(created.entry)
    ? { ...created.entry, forkedFromParent: true as const }
    : created.entry;
  const runStarted =
    !created.resetExisting &&
    isFreshChatSendStarted({ payload: params.runPayload, cached: params.runMeta?.cached === true });
  return {
    ok: true,
    key: created.key,
    sessionId: created.entry.sessionId,
    ...(params.creationOperationId
      ? {
          creationOperationId: params.creationOperationId,
          creationReplayed: params.creationReplayed,
        }
      : {}),
    entry,
    runStarted,
    publicRead: params.publicRead,
    ...(!created.resetExisting && params.runPayload ? params.runPayload : {}),
    ...(!created.resetExisting && runError ? { runError } : {}),
    resolved: created.resolved,
    ...(worktree ? { worktree } : {}),
  };
}
