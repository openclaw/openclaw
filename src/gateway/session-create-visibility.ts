import type { Result } from "@openclaw/normalization-core/result";
import type { ErrorShape, SessionVisibility } from "../../packages/gateway-protocol/src/index.js";
import { resolveSessionCreationVisibility } from "../config/sessions/creation-visibility.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { CreateGatewaySessionParams } from "./session-create-service.types.js";
import { invalidSessionRequest } from "./session-request-error.js";
import { isSessionVisibilityAllowed, resolveSessionVisibility } from "./session-sharing-policy.js";

export function resolveSessionCreateVisibility(
  params: Pick<
    CreateGatewaySessionParams,
    "cfg" | "getCurrentConfig" | "visibility" | "defaultVisibility" | "fork" | "creation"
  > & {
    /** Canonical key is available only after target binding. */
    sessionKey?: string;
  },
  existingEntry: SessionEntry | undefined,
  parentEntry?: SessionEntry,
): Result<SessionVisibility | undefined, ErrorShape> {
  const cfg = params.getCurrentConfig?.() ?? params.cfg;
  const inheritedDraft =
    parentEntry?.visibility === "draft" &&
    (params.creation?.via === "spawn" ||
      (params.fork === true && params.creation?.via === "operator"));
  // Pre-target admission keeps the parent/explicit policy; source defaults are
  // selected and rechecked once the creation owner binds the canonical key.
  const sourceVisibility = params.sessionKey
    ? resolveSessionCreationVisibility(cfg, params.sessionKey).visibility
    : undefined;
  const visibility =
    params.visibility ??
    (existingEntry
      ? undefined
      : inheritedDraft
        ? "draft"
        : (sourceVisibility ?? params.defaultVisibility));
  if (visibility && !existingEntry && !isSessionVisibilityAllowed(cfg, visibility)) {
    const guidance =
      visibility === "draft"
        ? ". Continue in the existing Draft or ask an administrator to enable Draft creation."
        : "";
    return invalidSessionRequest(`session visibility is disabled: ${visibility}${guidance}`, {
      details: { code: "SESSION_VISIBILITY_DISABLED", visibility },
    });
  }
  if (
    params.visibility &&
    existingEntry &&
    resolveSessionVisibility(existingEntry) !== params.visibility
  ) {
    return invalidSessionRequest("sessions.create visibility requires a new session");
  }
  return { ok: true, value: visibility };
}
