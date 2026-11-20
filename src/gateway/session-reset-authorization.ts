import {
  ErrorCodes,
  errorShape,
  missingScopeErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import { assertOperatorAccessProgramAllowed } from "../agents/admitted-run-context.js";
import { getRuntimeConfig } from "../config/io.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveMissingAgentHarnessSessionError } from "../sessions/agent-harness-session-key.js";
import { authorizeGatewaySessionCreation } from "./operator-role-policy.js";
import { ADMIN_SCOPE } from "./operator-scopes.js";
import type { GatewaySessionResetParams } from "./session-create-service.types.js";
import {
  prepareSessionPermissionModeAuthorization,
  readSessionPermissionAuthority,
} from "./session-permission-authorization.js";
import { resolvePluginSessionOwnershipError } from "./session-plugin-ownership.js";
import type { resolveSessionResetTarget } from "./session-reset-target.js";
import { buildResetWorkspaceFields } from "./session-reset-workspace.js";

/** Reset authorization is checked before cleanup and again at each lifecycle fence. */
export function resolveSessionResetAuthorizationError(
  entry: SessionEntry | undefined,
  params: GatewaySessionResetParams,
  permissionAuthority: Awaited<ReturnType<typeof prepareSessionPermissionModeAuthorization>>,
) {
  const permissionError = permissionAuthority.validate(
    entry,
    buildResetWorkspaceFields(entry, params).permissionMode,
  );
  if (permissionError) {
    return permissionError;
  }
  try {
    assertOperatorAccessProgramAllowed(params.operatorAuthority, entry?.cyberAccessProgram);
    return undefined;
  } catch (error) {
    return errorShape(ErrorCodes.FORBIDDEN, formatErrorMessage(error));
  }
}

type ResetTarget = Extract<Awaited<ReturnType<typeof resolveSessionResetTarget>>, { ok: true }>;

export function createSessionResetEntryChecks(
  params: GatewaySessionResetParams,
  resetTarget: ResetTarget,
) {
  const authorizeResetCreation = () =>
    authorizeGatewaySessionCreation({
      cfg: resetTarget.cfg,
      agentId: resetTarget.target.agentId,
      ...(params.operatorAuthority
        ? { authority: params.operatorAuthority }
        : params.operatorRoleActor
          ? { actor: params.operatorRoleActor }
          : { profileId: params.requestingOperatorProfileId }),
    });
  const resolveResetOwnershipError = (
    entry: SessionEntry | undefined,
    key = resetTarget.target.canonicalKey,
  ) =>
    resolvePluginSessionOwnershipError({
      action: "reset",
      entry,
      key,
      pluginOwnerId: params.authorizedPluginId,
    });
  const resolveResetHarnessError = (entry: SessionEntry | undefined) => {
    const message = resolveMissingAgentHarnessSessionError(resetTarget.target.canonicalKey, entry);
    return message ? errorShape(ErrorCodes.INVALID_REQUEST, message) : undefined;
  };
  const resolveFastModeSelectionError = (entry: SessionEntry | undefined) => {
    const selection = params.fastModeSelection;
    return entry &&
      selection &&
      selection.value !== entry.fastMode &&
      !selection.allowExistingChange
      ? missingScopeErrorShape({ missingScope: ADMIN_SCOPE, requiredScopes: [ADMIN_SCOPE] })
      : undefined;
  };
  return {
    authorizeResetCreation,
    resolveResetOwnershipError,
    resolveResetHarnessError,
    resolveFastModeSelectionError,
  };
}

export function prepareSessionResetPermissionAuthorization(
  params: GatewaySessionResetParams,
  resetTarget: ResetTarget,
  initialResetEntry: SessionEntry | undefined,
  assertReadAuthorized: () => void,
) {
  return prepareSessionPermissionModeAuthorization({
    getCurrentConfig: getRuntimeConfig,
    readAuthority: () => readSessionPermissionAuthority(getRuntimeConfig(), params),
    readSharing: params.readSessionSharing,
    assertCurrent: assertReadAuthorized,
    agentId: resetTarget.target.agentId,
    sessionKey: resetTarget.target.canonicalKey,
    storePath: resetTarget.storePath,
    existingEntry: initialResetEntry,
    permissionMode: buildResetWorkspaceFields(initialResetEntry, params).permissionMode,
  });
}
