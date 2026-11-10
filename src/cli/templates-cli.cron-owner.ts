import type { GatewayRequestFunction } from "../gateway/call.js";
import { isGatewayProtocolResponseError } from "../gateway/client.js";
import type { TemplateCronGateway } from "../templates/cron.js";

/** Capture native creator identity on the same connection, before cron.add is sent. */
export async function captureTemplateCronOwner(
  request: GatewayRequestFunction,
  signal: AbortSignal,
  options: Parameters<TemplateCronGateway["add"]>[1],
): Promise<{ expectedProfileId: string | null }> {
  options?.commitGuard?.();
  let expectedProfileId: string | null;
  try {
    const response = await request<{ profile?: { id?: string } }>("users.self", {}, { signal });
    if (!response.profile?.id) {
      throw new Error("Gateway did not confirm the automation creator; reconnect and retry.");
    }
    expectedProfileId = response.profile.id;
  } catch (error) {
    if (
      !isGatewayProtocolResponseError(error) ||
      error.gatewayCode !== "FORBIDDEN" ||
      error.message !== "users.self requires an authenticated user"
    ) {
      throw error;
    }
    expectedProfileId = null;
  }
  signal.throwIfAborted();
  options?.commitGuard?.();
  options?.captureOwnerProfileId?.(expectedProfileId ?? undefined);
  return { expectedProfileId };
}
