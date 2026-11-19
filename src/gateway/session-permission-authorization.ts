import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { ADMIN_SCOPE } from "./operator-scopes.js";
import { isSessionCreatorProfile } from "./session-creator.js";

const permissionRank = { "read-only": 0, guarded: 1, workspace: 2, full: 3 } as const;

/** Session writers share this ceiling; sharing write access never grants escalation. */
export function authorizeSessionPermissionModeChange(params: {
  existingEntry: SessionEntry | undefined;
  permissionMode: SessionEntry["permissionMode"];
  profileId?: string;
  /** Omitted only for trusted in-process owners, never an unidentified public caller. */
  scopes: readonly string[] | undefined;
}): ErrorShape | undefined {
  const { existingEntry, permissionMode, scopes } = params;
  if (
    !existingEntry ||
    existingEntry.permissionMode === permissionMode ||
    scopes === undefined ||
    scopes.includes(ADMIN_SCOPE) ||
    isSessionCreatorProfile(existingEntry.createdActor, params.profileId)
  ) {
    return undefined;
  }
  // Default can combine non-equivalent exec, file and sandbox policies. Only read-only
  // is provably no looser without resolving that whole run's execution policy.
  if (
    permissionMode !== undefined &&
    permissionRank[permissionMode] <= permissionRank[existingEntry.permissionMode ?? "read-only"]
  ) {
    return undefined;
  }
  return errorShape(
    ErrorCodes.FORBIDDEN,
    "Only the session creator or an admin can loosen this session's permission mode. Choose a stricter mode or ask the creator to change it.",
  );
}
