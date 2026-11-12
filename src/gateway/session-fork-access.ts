import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../config/sessions.js";
import { resolveSessionAccess } from "../config/sessions/session-access.js";
import type { CreateGatewaySessionParams } from "./session-create-service.types.js";
import { isSessionCreatorProfile } from "./session-creator.js";
import { resolvePluginSessionOwnershipError } from "./session-plugin-ownership.js";

type ForkAccessParams = Pick<
  CreateGatewaySessionParams,
  | "cfg"
  | "getCurrentConfig"
  | "fork"
  | "applyAgentPermissionDefault"
  | "requestingOperatorProfileId"
  | "requestingOperatorScopes"
  | "operatorRoleActor"
  | "authorizedPluginId"
>;

/** Call with the freshly loaded parent while its lifecycle fence is held. */
export function resolveSessionForkParentError(
  params: ForkAccessParams,
  key: string,
  entry: SessionEntry,
): ErrorShape | undefined {
  if (params.fork === true) {
    const access = resolveSessionAccess(params.getCurrentConfig?.() ?? params.cfg, key, entry);
    const profileId = params.requestingOperatorProfileId;
    const actor = params.operatorRoleActor;
    const direct = Boolean(
      params.applyAgentPermissionDefault === true &&
      profileId &&
      (!actor || (actor.kind === "operator" && actor.profileId === profileId)),
    );
    const mayFork =
      direct &&
      (params.requestingOperatorScopes?.includes("operator.admin") === true ||
        isSessionCreatorProfile(entry.createdActor, profileId));
    if (access && access.mode !== "unrestricted" && !mayFork) {
      return errorShape(
        ErrorCodes.FORBIDDEN,
        "Only the session creator or an admin can fork restricted history.",
      );
    }
  }
  return resolvePluginSessionOwnershipError({
    action: params.fork === true ? "fork" : "link",
    entry,
    key,
    pluginOwnerId: params.authorizedPluginId,
  });
}
