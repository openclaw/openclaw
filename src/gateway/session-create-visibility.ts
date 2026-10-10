import type { Result } from "@openclaw/normalization-core/result";
import type { ErrorShape, SessionVisibility } from "../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { CreateGatewaySessionParams } from "./session-create-service.types.js";
import { invalidSessionRequest } from "./session-request-error.js";
import { isSessionVisibilityAllowed, resolveSessionVisibility } from "./session-sharing-policy.js";

export function resolveSessionCreateVisibility(
  params: Pick<CreateGatewaySessionParams, "cfg" | "visibility" | "defaultVisibility">,
  existingEntry: SessionEntry | undefined,
): Result<SessionVisibility | undefined, ErrorShape> {
  const visibility = params.visibility ?? (existingEntry ? undefined : params.defaultVisibility);
  if (visibility && !existingEntry && !isSessionVisibilityAllowed(params.cfg, visibility)) {
    return invalidSessionRequest(`session visibility is disabled: ${visibility}`, {
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
