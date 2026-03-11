import { normalizeLegacyDeliveryInput } from "../legacy-delivery.js";
import type { CronDelivery, CronJobCreate } from "../types.js";

export function normalizeCronCreateDeliveryInput(input: CronJobCreate): CronJobCreate {
  const payloadRecord =
    input.payload && typeof input.payload === "object"
      ? ({ ...input.payload } as Record<string, unknown>)
      : null;
  const deliveryRecord =
    input.delivery && typeof input.delivery === "object"
      ? ({ ...input.delivery } as Record<string, unknown>)
      : null;
  const normalizedLegacy = normalizeLegacyDeliveryInput({
    delivery: deliveryRecord,
    payload: payloadRecord,
  });
  if (!normalizedLegacy.mutated) {
    return input;
  }
  return {
    ...input,
    payload: payloadRecord ? (payloadRecord as typeof input.payload) : input.payload,
    delivery: (normalizedLegacy.delivery as CronDelivery | undefined) ?? input.delivery,
  };
}

export function resolveInitialCronDelivery(input: CronJobCreate): CronDelivery | undefined {
  if (input.delivery) {
    return input.delivery;
  }
  if (input.sessionTarget === "isolated" && input.payload.kind === "agentTurn") {
    return { mode: "announce" };
  }
  return undefined;
}
