import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import { assertOperatorAccessProgramAllowed } from "../agents/admitted-run-context.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { GatewaySessionResetParams } from "./session-create-service.types.js";
import { authorizeSessionPermissionModeChange } from "./session-permission-authorization.js";
import { buildResetWorkspaceFields } from "./session-reset-workspace.js";

/** Reset authorization is checked before cleanup and again at each lifecycle fence. */
export function resolveSessionResetAuthorizationError(
  entry: SessionEntry | undefined,
  params: GatewaySessionResetParams,
) {
  const permissionError = authorizeSessionPermissionModeChange({
    existingEntry: entry,
    permissionMode: buildResetWorkspaceFields(entry, params).permissionMode,
    profileId:
      params.operatorAuthority?.profileId ??
      params.requestingOperatorProfileId ??
      (params.operatorRoleActor?.kind === "operator"
        ? params.operatorRoleActor.profileId
        : undefined),
    scopes:
      params.operatorAuthority?.scopes ??
      params.requestingOperatorScopes ??
      (params.requestingOperatorProfileId || params.operatorRoleActor?.kind === "operator"
        ? []
        : undefined),
  });
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
