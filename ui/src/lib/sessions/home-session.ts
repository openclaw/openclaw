import type { SessionsResolveResult } from "../../../../packages/gateway-protocol/src/index.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { isUiGlobalSessionKey, parseAgentSessionKey } from "./session-key.ts";

export function homeSessionRequiresConfirmation(
  snapshot: Pick<ApplicationGatewaySnapshot, "hello">,
): boolean {
  const cap = snapshot.hello?.auth?.sessionCap;
  return cap === "none" || cap === "view";
}

/** Confirm restricted Home targets before mounting consumers that refresh their descriptor. */
export async function resolveHomeSession(
  snapshot: Pick<ApplicationGatewaySnapshot, "client" | "hello">,
  target: { sessionKey: string; agentId: string; mainKey: string },
): Promise<boolean> {
  const rest = parseAgentSessionKey(target.sessionKey)?.rest ?? target.sessionKey;
  if (
    !homeSessionRequiresConfirmation(snapshot) ||
    (!isUiGlobalSessionKey(target.sessionKey) &&
      rest.toLowerCase() !== target.mainKey.toLowerCase())
  ) {
    return true;
  }
  if (!snapshot.client) {
    return false;
  }
  try {
    const result = await snapshot.client.request<SessionsResolveResult>("sessions.resolve", {
      key: target.sessionKey,
      agentId: target.agentId,
      allowMissing: true,
    });
    return result.ok;
  } catch (error) {
    // Hidden and missing sessions stay indistinguishable; transport failures remain retryable errors.
    if (
      error instanceof GatewayRequestError &&
      (error.gatewayCode === "INVALID_REQUEST" || error.gatewayCode === "FORBIDDEN")
    ) {
      return false;
    }
    throw error;
  }
}
