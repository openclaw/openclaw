import { buildDeliveryFromLegacyPayload, hasLegacyDeliveryHints } from "../legacy-delivery.js";
import type { CronDelivery, CronJobCreate } from "../types.js";

export function resolveInitialCronDelivery(input: CronJobCreate): CronDelivery | undefined {
  if (input.delivery) {
    return input.delivery;
  }
  const payloadRecord =
    input.payload && typeof input.payload === "object"
      ? (input.payload as Record<string, unknown>)
      : undefined;
  if (payloadRecord && hasLegacyDeliveryHints(payloadRecord)) {
    return buildDeliveryFromLegacyPayload(payloadRecord) as CronDelivery;
  }
  if (input.sessionTarget === "isolated" && input.payload.kind === "agentTurn") {
    return { mode: "announce" };
  }
  return undefined;
}
