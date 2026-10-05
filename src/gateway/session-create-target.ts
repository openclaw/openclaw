import type { Result } from "@openclaw/normalization-core/result";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  type ErrorShape,
  errorShape,
  missingScopeErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { resolveAgentConfig } from "../agents/agent-scope.js";
import { isEmbeddedAgentRunActive } from "../agents/embedded-agent-runner/runs.js";
import { withSessionEntriesFromStoresInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { isSessionWorkAdmissionActive } from "../sessions/session-lifecycle-admission.js";
import { authorizeGatewaySessionCreation, resolveCreatorSandbox } from "./operator-role-policy.js";
import { ADMIN_SCOPE } from "./operator-scopes.js";
import { prepareSessionForkFilesystemRoot } from "./server-methods/session-create-root.js";
import type { CreateGatewaySessionParams } from "./session-create-service.types.js";
import { resolvePluginSessionOwnershipError } from "./session-plugin-ownership.js";
import { captureSessionMutationRouting } from "./session-sharing-preparation.js";
import { findCanonicalStoreMatch } from "./session-utils-store-selection.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils-store.js";
import type { GatewaySessionStoreTarget } from "./session-utils-store.types.js";

type SessionCreateTargetContext = {
  target: GatewaySessionStoreTarget;
  expectedSessionId?: string;
  lifecycleIdentities: readonly string[];
  parent?: InternalSessionEntry;
  parentAgentId?: string;
  operatorAuthority?: AdmittedRunOperatorAuthority;
};

type PreparedSessionCreateTarget = {
  entry: InternalSessionEntry | undefined;
  permissionMode: InternalSessionEntry["permissionMode"];
  assertPermissionDefaultCurrent?: () => void;
  creationSandbox: "required" | undefined;
  sandboxRequired: boolean;
  inheritedWorkspace?: Pick<
    InternalSessionEntry,
    "projectId" | "spawnedCwd" | "spawnedWorkspaceDir" | "sessionRoot"
  >;
};

// The caller holds target lifecycle custody from this reread through commit and rollback.
export async function readSessionCreateTarget(
  params: CreateGatewaySessionParams,
  context: SessionCreateTargetContext,
): Promise<Result<PreparedSessionCreateTarget, ErrorShape>> {
  const { target } = context;
  const assertRoutingCurrent = captureSessionMutationRouting(params.cfg);
  const assertCurrent = () => {
    params.commitGuard?.();
    assertRoutingCurrent(params.getCurrentConfig?.() ?? params.cfg);
  };
  const validate = (entry: InternalSessionEntry | undefined) => {
    assertCurrent();
    return validateSessionCreateTarget(params, context, entry);
  };
  assertCurrent();
  // Process-held incognito stores retain their native owner until its complete cutover.
  if (isIncognitoSessionKey(target.canonicalKey)) {
    return validate(
      loadGatewaySessionEntryReadOnly(target.canonicalKey, { agentId: target.agentId }).entry,
    );
  }
  const result = await withSessionEntriesFromStoresInWorker(
    [
      {
        agentId: target.agentId,
        storePath: target.storePath,
        sessionKeys: target.storeKeys,
        projection: "exact",
      },
    ],
    ([read]) => {
      read!.assertCurrent();
      const store = Object.fromEntries(
        read!.result.entries.map(({ sessionKey, entry }) => [sessionKey, entry]),
      );
      return validate(findCanonicalStoreMatch(store, target.storeKeys)?.entry);
    },
    { ordered: true },
  );
  assertCurrent();
  return result;
}

function validateSessionCreateTarget(
  params: CreateGatewaySessionParams,
  context: SessionCreateTargetContext,
  currentTargetEntry: InternalSessionEntry | undefined,
): Result<PreparedSessionCreateTarget, ErrorShape> {
  const { target, expectedSessionId, lifecycleIdentities, operatorAuthority } = context;
  // Lifecycle custody keeps this owner stable through naming and filesystem preparation.
  const existingOwnershipError = resolvePluginSessionOwnershipError({
    action: "adopt",
    entry: currentTargetEntry,
    key: target.canonicalKey,
    pluginOwnerId: params.authorizedPluginId,
  });
  if (existingOwnershipError) {
    return { ok: false, error: existingOwnershipError };
  }
  if (currentTargetEntry) {
    const requestedCwd = normalizeOptionalString(params.spawnedCwd);
    const requestedRoot = normalizeOptionalString(params.sessionRoot ?? params.defaultSessionRoot);
    const requestedNode = normalizeOptionalString(params.execNode);
    const requestedExecCwd = normalizeOptionalString(params.execCwd);
    const changesFilesystemBinding =
      params.prepareLifecycle !== undefined ||
      (requestedCwd !== undefined && requestedCwd !== currentTargetEntry.spawnedCwd) ||
      (requestedRoot !== undefined && requestedRoot !== currentTargetEntry.sessionRoot) ||
      (requestedNode !== undefined &&
        (currentTargetEntry.execHost !== "node" ||
          requestedNode !== currentTargetEntry.execNode ||
          (requestedExecCwd !== undefined && requestedExecCwd !== currentTargetEntry.execCwd)));
    if (changesFilesystemBinding) {
      // The fence queues new work; it cannot move a checkout underneath an admitted turn.
      // Preparation can allocate before returning, so reject before invoking it.
      if (currentTargetEntry.sessionId !== expectedSessionId) {
        return {
          ok: false,
          error: errorShape(
            ErrorCodes.UNAVAILABLE,
            `Session ${target.canonicalKey} changed before workspace preparation; retry.`,
          ),
        };
      }
      if (
        isSessionWorkAdmissionActive(target.storePath, lifecycleIdentities) ||
        isEmbeddedAgentRunActive(currentTargetEntry.sessionId)
      ) {
        return {
          ok: false,
          error: errorShape(
            ErrorCodes.UNAVAILABLE,
            `Session ${target.canonicalKey} is still active; retry workspace preparation after its work finishes.`,
          ),
        };
      }
    }
  }
  if (!currentTargetEntry) {
    const creationError = authorizeGatewaySessionCreation({
      cfg: params.cfg,
      agentId: target.agentId,
      ...(params.operatorRoleActor
        ? { actor: params.operatorRoleActor }
        : { profileId: params.requestingOperatorProfileId }),
    });
    if (creationError) {
      return { ok: false, error: creationError };
    }
  }
  let permissionMode = params.permissionMode;
  let assertPermissionDefaultCurrent: (() => void) | undefined;
  if (
    !currentTargetEntry &&
    permissionMode === undefined &&
    params.applyAgentPermissionDefault &&
    params.creation?.via === "operator" &&
    params.fork !== true &&
    !params.initialEntry &&
    !params.catalogTarget &&
    !params.authorizedPluginId &&
    operatorAuthority
  ) {
    const configuredMode = resolveAgentConfig(params.cfg, target.agentId)?.newSessionPermissionMode;
    if (configuredMode) {
      operatorAuthority.assertCurrent();
      if (configuredMode === "full" && !operatorAuthority.scopes.includes(ADMIN_SCOPE)) {
        return {
          ok: false,
          error: missingScopeErrorShape({
            missingScope: ADMIN_SCOPE,
            requiredScopes: [ADMIN_SCOPE],
          }),
        };
      }
      permissionMode = configuredMode;
      assertPermissionDefaultCurrent = () => {
        operatorAuthority.assertCurrent();
        const cfg = params.getCurrentConfig?.() ?? params.cfg;
        if (resolveAgentConfig(cfg, target.agentId)?.newSessionPermissionMode !== configuredMode) {
          throw new Error("New-session permission default changed; retry creation.");
        }
      };
      assertPermissionDefaultCurrent();
    }
  }
  // Delegated isolation survives changes to the creator's current role.
  const creationSandbox =
    params.creation?.sandbox ??
    (params.creation ? resolveCreatorSandbox(params.cfg, params.creation) : undefined);
  const sandboxRequired =
    currentTargetEntry?.sandbox === "required" || creationSandbox === "required";
  const forkWorkspace =
    params.fork === true &&
    context.parent &&
    !currentTargetEntry &&
    context.parentAgentId === target.agentId &&
    !normalizeOptionalString(params.projectId) &&
    !params.spawnedCwd &&
    !params.sessionRoot &&
    !params.execNode &&
    !params.prepareLifecycle &&
    !params.pendingWorktree &&
    !params.pendingProjectGitUrl
      ? prepareSessionForkFilesystemRoot({
          cfg: params.cfg,
          parent: context.parent,
          targetAgentId: target.agentId,
          sessionKey: target.canonicalKey,
          sandboxRequired,
        })
      : undefined;
  if (forkWorkspace && !forkWorkspace.ok) {
    return { ok: false, error: forkWorkspace.error };
  }
  return {
    ok: true,
    value: {
      entry: currentTargetEntry,
      permissionMode,
      assertPermissionDefaultCurrent,
      creationSandbox,
      sandboxRequired,
      inheritedWorkspace: forkWorkspace?.value,
    },
  };
}
