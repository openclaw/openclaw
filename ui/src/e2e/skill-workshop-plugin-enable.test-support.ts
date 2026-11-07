import { setTimeout as delay } from "node:timers/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isGatewayProtocolResponseError, type GatewayClient } from "../../../src/gateway/client.ts";

export async function disableWorkshopWhenIdle(
  client: Pick<GatewayClient, "request">,
): Promise<void> {
  const deadline = performance.now() + 60_000;
  for (;;) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      throw new Error("Skill Workshop cleanup exceeded its admission deadline");
    }
    try {
      await client.request(
        "plugins.setEnabled",
        { pluginId: "skill-workshop", enabled: false },
        { timeoutMs: Math.min(20_000, remaining) },
      );
      return;
    } catch (error) {
      // Only a correlated refusal proves that repeating this mutation is safe.
      if (
        !isGatewayProtocolResponseError(error) ||
        error.gatewayCode !== "UNAVAILABLE" ||
        error.retryable !== true ||
        !isRecord(error.details) ||
        error.details.mutationAccepted !== false ||
        error.retryAfterMs === undefined ||
        !Number.isFinite(error.retryAfterMs) ||
        error.retryAfterMs <= 0 ||
        error.retryAfterMs >= deadline - performance.now()
      ) {
        throw error;
      }
      await delay(error.retryAfterMs);
      if (performance.now() >= deadline) {
        throw error;
      }
    }
  }
}
