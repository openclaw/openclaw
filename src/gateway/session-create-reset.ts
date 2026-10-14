import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentMainSessionKey } from "../config/sessions/main-session.js";
import { projectPublicSessionEntry } from "../config/sessions/session-entry-projection.js";
import { normalizeAgentId, resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import type {
  CreateGatewaySessionParams,
  CreateGatewaySessionResult,
} from "./session-create-service.types.js";
import { loadSessionLifecycleRuntime } from "./session-lifecycle-runtime-loader.js";
import { invalidSessionRequest } from "./session-request-error.js";

export function tryResetGatewaySessionForCreation(
  params: CreateGatewaySessionParams,
  {
    parentSessionKey: canonicalParentSessionKey,
    parentSelectedAgentId,
    agentId,
    parentIncognito,
    requestedKey,
    requestedToolOverrides,
    commitGuard,
  }: {
    parentSessionKey: string | undefined;
    parentSelectedAgentId: string | undefined;
    agentId: string;
    parentIncognito: boolean;
    requestedKey: string | undefined;
    requestedToolOverrides: boolean;
    commitGuard: (() => void) | undefined;
  },
): Promise<CreateGatewaySessionResult> | undefined {
  if (
    canonicalParentSessionKey &&
    params.fork !== true &&
    params.emitCommandHooks === true &&
    !requestedKey &&
    params.resetMainWhenUnspecified === true &&
    !requestedToolOverrides &&
    !parentIncognito &&
    // Catalog targets need a fresh locked row; resetting main would return before
    // the catalog-owned model/runtime pair is persisted.
    !params.catalogTarget &&
    params.cfg.session?.dmScope === "main"
  ) {
    const parentAgentId = normalizeAgentId(
      parentSelectedAgentId ?? resolveAgentIdFromSessionKey(canonicalParentSessionKey) ?? agentId,
    );
    const parentMainKey = resolveAgentMainSessionKey({ cfg: params.cfg, agentId: parentAgentId });
    if (canonicalParentSessionKey === parentMainKey) {
      return resetGatewaySessionForCreation(
        params,
        canonicalParentSessionKey,
        parentSelectedAgentId,
        commitGuard,
      );
    }
  }
  return undefined;
}

async function resetGatewaySessionForCreation(
  params: CreateGatewaySessionParams,
  canonicalParentSessionKey: string,
  parentSelectedAgentId: string | undefined,
  commitGuard: (() => void) | undefined,
): Promise<CreateGatewaySessionResult> {
  if (params.visibility) {
    return invalidSessionRequest("sessions.create visibility requires a new session");
  }
  const { performGatewaySessionReset } = await loadSessionLifecycleRuntime();
  const spawnedCwd = normalizeOptionalString(params.spawnedCwd);
  const execCwd = normalizeOptionalString(params.execCwd);
  const resetResult = await performGatewaySessionReset({
    key: canonicalParentSessionKey,
    ...(parentSelectedAgentId ? { agentId: parentSelectedAgentId } : {}),
    ...(params.requestingOperatorProfileId
      ? { requestingOperatorProfileId: params.requestingOperatorProfileId }
      : {}),
    ...(params.operatorRoleActor ? { operatorRoleActor: params.operatorRoleActor } : {}),
    reason: "new",
    commandSource: params.commandSource,
    ...(params.creation ? { creation: params.creation } : {}),
    ...(spawnedCwd ? { spawnedCwd } : {}),
    ...(params.sessionRoot ? { sessionRoot: params.sessionRoot } : {}),
    ...(params.permissionMode ? { permissionMode: params.permissionMode } : {}),
    ...(params.fastMode !== undefined
      ? {
          fastModeSelection: {
            value: params.fastMode,
            allowExistingChange: params.allowExistingModelSelection === true,
          },
        }
      : {}),
    ...(params.prepareLifecycle ? { prepareLifecycle: params.prepareLifecycle } : {}),
    ...(params.onLifecycleCleanupError
      ? { onLifecycleCleanupError: params.onLifecycleCleanupError }
      : {}),
    ...(params.execNode ? { execNode: params.execNode } : {}),
    ...(execCwd ? { execCwd } : {}),
    ...(params.clearExecBinding ? { clearExecBinding: true } : {}),
    ...(params.clearSpawnedCwd && !spawnedCwd ? { clearSpawnedCwd: true } : {}),
    ...(params.armSessionDiffBaselineCapture ? { armSessionDiffBaselineCapture: true } : {}),
    ...(commitGuard ? { assertAuthorizedInstance: commitGuard } : {}),
  });
  if (!resetResult.ok) {
    return resetResult;
  }
  if ("incognitoDeleted" in resetResult) {
    return invalidSessionRequest("incognito sessions cannot reset in place");
  }
  return {
    ok: true,
    key: resetResult.key,
    agentId: resetResult.agentId,
    entry: projectPublicSessionEntry(resetResult.entry),
    resolved: resetResult.resolved,
    resetExisting: true,
    postCommit: { status: "completed" },
  };
}
