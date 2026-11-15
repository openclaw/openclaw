import {
  ErrorCodes,
  errorShape,
  missingScopeErrorShape,
  type ErrorShape,
  type SessionsPatchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  hasAgentRunContextExecutionOwner,
  listAgentRunsForSession,
} from "../../infra/agent-run-registry.js";
import { isSessionControllerWorkActive } from "../../sessions/session-controller.lifecycle.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import {
  readSessionWorkerPlacementAsync,
  type SessionWorkerPlacementContext,
} from "../worker-environments/session-placement-lifecycle.js";
import {
  prepareSessionPatchPermissionChange,
  type ActiveSessionPermissionChange,
} from "./sessions-patch-permissions.runtime.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

export type PreparedSessionPatchExecutionPermission =
  | { ok: false; error: ErrorShape }
  | {
      ok: true;
      validate?: () => ErrorShape | undefined;
      change?: ActiveSessionPermissionChange;
    };

export async function prepareSessionPatchExecutionPermissionChange(
  params: Parameters<typeof prepareSessionPatchSandboxChange>[0] & {
    context: GatewayRequestContext;
    agentId: string;
    assertCurrent: () => ErrorShape | undefined;
  },
): Promise<PreparedSessionPatchExecutionPermission> {
  const permissionChanged = params.entry.permissionMode !== params.existingEntry?.permissionMode;
  const sandboxChanged =
    params.entry.sandboxMode !== params.existingEntry?.sandboxMode ||
    params.entry.nativeRuntimeConsent !== params.existingEntry?.nativeRuntimeConsent;
  const validate =
    (permissionChanged && !("permissionMode" in params.patch)) ||
    sandboxChanged ||
    "sandboxMode" in params.patch ||
    "nativeRuntimeConsent" in params.patch
      ? await prepareSessionPatchSandboxChange(params)
      : undefined;
  const permission =
    (permissionChanged || "permissionMode" in params.patch) && params.existingEntry?.sessionId
      ? prepareSessionPatchPermissionChange({
          ...params,
          sessionId: params.existingEntry.sessionId,
        })
      : { ok: true as const };
  return permission.ok ? { ...permission, validate } : permission;
}

export async function prepareSessionPatchSandboxChange(
  params: Parameters<typeof validateSessionPatchSandboxChange>[0],
): Promise<() => ErrorShape | undefined> {
  await readSessionWorkerPlacementAsync({
    context: params.context,
    sessionId: params.existingEntry?.sessionId,
  });
  return () => validateSessionPatchSandboxChange(params);
}

/** Check authority and idle execution at the synchronous write boundary. */
function validateSessionPatchSandboxChange(params: {
  client: GatewayClient | null;
  context: SessionWorkerPlacementContext;
  patch: SessionsPatchParams;
  existingEntry: SessionEntry | undefined;
  entry: SessionEntry;
  sessionKey: string;
  agentId: string;
  storePath: string;
  lifecycleIdentities: readonly (string | undefined)[];
}): ErrorShape | undefined {
  if (params.client !== null && !params.client.connect.scopes?.includes(ADMIN_SCOPE)) {
    return missingScopeErrorShape({ missingScope: ADMIN_SCOPE, requiredScopes: [ADMIN_SCOPE] });
  }
  const grantingConsent = typeof params.patch.nativeRuntimeConsent === "string";
  if (
    params.entry.sandbox === "required" &&
    (params.entry.sandboxMode === "off" || grantingConsent)
  ) {
    return errorShape(
      ErrorCodes.INVALID_REQUEST,
      "This session requires a sandbox and cannot run without one.",
    );
  }
  if (
    grantingConsent &&
    (!params.existingEntry ||
      params.patch.expectedSessionId !== params.existingEntry.sessionId ||
      params.patch.expectedLifecycleRevision !== params.existingEntry.lifecycleRevision)
  ) {
    return errorShape(
      ErrorCodes.INVALID_REQUEST,
      "Native runtime consent must target the current session incarnation.",
    );
  }
  if (
    !grantingConsent &&
    params.existingEntry?.sandboxMode === params.entry.sandboxMode &&
    params.existingEntry?.permissionMode === params.entry.permissionMode &&
    params.existingEntry?.nativeRuntimeConsent === params.entry.nativeRuntimeConsent
  ) {
    return undefined;
  }
  const sessionId = params.existingEntry?.sessionId;
  const placement = sessionId
    ? params.context.workerSessionPlacementService?.getMany([sessionId]).get(sessionId)
    : undefined;
  if (
    isSessionControllerWorkActive(params.storePath, params.lifecycleIdentities, params.agentId) ||
    listAgentRunsForSession({ sessionKey: params.sessionKey, sessionId }).some(({ runId }) =>
      hasAgentRunContextExecutionOwner(runId),
    ) ||
    (placement?.executionMode === "worker-turn" && placement.turnClaim)
  ) {
    return errorShape(
      ErrorCodes.INVALID_REQUEST,
      "Stop the active run before changing this session's execution permissions.",
    );
  }
  return undefined;
}
