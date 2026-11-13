import { isDeepStrictEqual } from "node:util";
import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import { resolveSessionCreationVisibility } from "../config/sessions/creation-visibility.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CreateGatewaySessionParams } from "./session-create-service.types.js";
import { resolveSessionCreateVisibility } from "./session-create-visibility.js";
import { invalidSessionRequest } from "./session-request-error.js";

export function resolveAttendedCreationAccess(
  cfg: OpenClawConfig,
  sessionKey: string,
  parent: Pick<SessionEntry, "access" | "visibility"> | undefined,
  params: Pick<
    CreateGatewaySessionParams,
    "access" | "attendedControlUiProfile" | "creation" | "requestingOperatorProfileId"
  >,
) {
  return (
    params.access ??
    resolveSessionCreationVisibility(cfg, sessionKey, parent, {
      attendedProfileOperator:
        params.attendedControlUiProfile === true &&
        params.creation?.via === "operator" &&
        params.creation.actor?.type === "human" &&
        params.creation.actor.source === "profile" &&
        params.creation.actor.id === params.requestingOperatorProfileId,
    }).access
  );
}

export function prepareSessionCreationSharing({
  params,
  sessionKey,
  existingEntry,
  parentEntry,
}: {
  params: CreateGatewaySessionParams;
  sessionKey: string;
  existingEntry: SessionEntry | undefined;
  parentEntry: SessionEntry | undefined;
}) {
  if (
    params.access &&
    existingEntry &&
    JSON.stringify(params.access) !== JSON.stringify(existingEntry.access)
  ) {
    return invalidSessionRequest(
      "sessions.create access requires a new session; use sessions.patch to manage an existing audience",
    );
  }
  const cfg = params.getCurrentConfig?.() ?? params.cfg;
  const visibility = resolveSessionCreateVisibility(
    { ...params, cfg, getCurrentConfig: () => cfg, sessionKey },
    existingEntry,
    parentEntry,
  );
  if (!visibility.ok) {
    return visibility;
  }
  const creationAccess = resolveAttendedCreationAccess(cfg, sessionKey, parentEntry, params);
  const validate = existingEntry
    ? undefined
    : () => {
        const currentCfg = params.getCurrentConfig?.() ?? params.cfg;
        const current = resolveSessionCreateVisibility(
          { ...params, cfg: currentCfg, getCurrentConfig: () => currentCfg, sessionKey },
          undefined,
          parentEntry,
        );
        if (!current.ok) {
          return current.error;
        }
        const currentAccess = resolveAttendedCreationAccess(
          currentCfg,
          sessionKey,
          parentEntry,
          params,
        );
        // Reject a stale prepared audience before the writer can publish the row.
        return current.value === visibility.value &&
          isDeepStrictEqual(currentAccess, creationAccess)
          ? undefined
          : errorShape(ErrorCodes.INVALID_REQUEST, "session creation sharing policy changed");
      };
  return { ok: true as const, visibility, creationAccess, validate };
}
