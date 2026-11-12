import { resolveSessionCreationVisibility } from "../config/sessions/creation-visibility.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CreateGatewaySessionParams } from "./session-create-service.types.js";

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
