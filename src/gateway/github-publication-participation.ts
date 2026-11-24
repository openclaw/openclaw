import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { assertAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { participationAllowsTool } from "../agents/participation-ceiling.js";
import { getGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { isParticipantPublicationMethod } from "./session-method-policy.js";

/** Only the current host-admitted turn supplies this alternative; wire data cannot create it. */
export function readParticipantPublicationAuthority(method: string, params: unknown) {
  if (!method.startsWith("sessions.github.")) {
    return undefined;
  }
  const caller = getGatewayToolCallerIdentity();
  const authority = caller?.operatorAuthority;
  if (!caller || !authority?.participationCeiling) {
    return undefined;
  }
  assertAdmittedRunOperatorAuthority(authority);
  authority.signal?.throwIfAborted();
  const request = asOptionalRecord(params);
  const observation = [
    "sessions.github.readiness",
    "sessions.github.options",
    "sessions.github.status",
  ].includes(method);
  if (
    !request ||
    (!isParticipantPublicationMethod(method, request) && !observation) ||
    request.publishingSessionKey !== undefined ||
    request.sessionKey !== caller.sessionKey ||
    (request.agentId !== undefined &&
      (typeof request.agentId !== "string" ||
        normalizeAgentId(request.agentId) !== normalizeAgentId(caller.agentId))) ||
    !participationAllowsTool(authority.participationCeiling, "github_publish")
  ) {
    throw new Error(
      "Participating GitHub requests must stay in this conversation and cannot inspect, merge, close, or select another publisher.",
    );
  }
  return authority;
}
