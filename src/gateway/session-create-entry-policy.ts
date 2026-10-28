import type { Result } from "@openclaw/normalization-core/result";
import type { ErrorShape, SessionVisibility } from "../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { CreateGatewaySessionParams } from "./session-create-service.types.js";
import { invalidSessionRequest, unavailableSessionRequest } from "./session-request-error.js";
import { isSessionVisibilityAllowed, resolveSessionVisibility } from "./session-sharing-policy.js";

type SessionCreateEntryPolicy = {
  params: Pick<
    CreateGatewaySessionParams,
    | "cfg"
    | "creation"
    | "visibility"
    | "defaultVisibility"
    | "initialEntry"
    | "initialAssistantMessage"
    | "fork"
    | "atomicInitialization"
    | "deviceFolder"
    | "catalogTarget"
  >;
  existingEntry: SessionEntry | undefined;
  parentEntry: SessionEntry | undefined;
  sessionKey: string;
  hasWorkspacePreparation: boolean;
  hasSpawnToolPolicy: boolean;
};

/** Resolve creation-only policy before adopting or exposing the selected session. */
export function resolveSessionCreateEntryPolicy(
  input: SessionCreateEntryPolicy,
): Result<SessionVisibility | undefined, ErrorShape> {
  const { params, existingEntry } = input;
  if (!params.initialEntry && existingEntry?.initializationPending === true) {
    return unavailableSessionRequest(
      `Session ${input.sessionKey} is still initializing; retry creation later.`,
    );
  }
  if (
    params.initialAssistantMessage &&
    (existingEntry !== undefined ||
      params.fork === true ||
      params.atomicInitialization === true ||
      params.initialEntry?.initializationPending === true)
  ) {
    return invalidSessionRequest(
      "initial assistant transcript requires a new session without fork or deferred initialization",
    );
  }
  if (params.initialEntry && existingEntry !== undefined) {
    return invalidSessionRequest("trusted initial session state requires a new session");
  }
  if (
    params.deviceFolder &&
    existingEntry !== undefined &&
    (existingEntry.deviceFolder?.deviceId !== params.deviceFolder.deviceId ||
      existingEntry.deviceFolder.path !== params.deviceFolder.path)
  ) {
    return invalidSessionRequest("device folder requires a new session or its original folder");
  }
  if (params.catalogTarget && existingEntry !== undefined) {
    return invalidSessionRequest("catalog session target requires a new session");
  }
  if (input.hasWorkspacePreparation && existingEntry !== undefined) {
    return invalidSessionRequest("workspace preparation requires a new session");
  }
  if (input.hasSpawnToolPolicy && existingEntry !== undefined) {
    return invalidSessionRequest("spawn tool policy requires a new session");
  }
  const inheritedVisibility =
    params.creation?.via === "spawn" &&
    input.parentEntry?.visibility === "draft" &&
    params.cfg.session?.sharing?.drafts !== false
      ? "draft"
      : params.defaultVisibility;
  const visibility = params.visibility ?? (existingEntry ? undefined : inheritedVisibility);
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
