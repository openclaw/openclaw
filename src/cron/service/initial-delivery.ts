import { log } from "../../infra/logging.js";
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
    // Warn when an isolated session uses channel="last" which will likely fail
    // because isolated sessions have no prior inbound message context.
    const isIsolated =
      input.sessionTarget === "isolated" ||
      (!input.sessionTarget && input.payload.kind === "agentTurn");
    const channel = input.delivery.channel;
    if (isIsolated && (channel === "last" || (!channel && input.delivery.mode === "announce"))) {
      log.warn(
        'cron job uses delivery.channel="last" (or default) with an isolated session. ' +
          "Isolated sessions have no prior channel context, so delivery may silently fail. " +
          "Set an explicit delivery.channel (e.g. discord, telegram) to ensure delivery.",
      );
    }
    return input.delivery;
  }
  if (input.sessionTarget === "isolated" && input.payload.kind === "agentTurn") {
    return { mode: "announce" };
  }
  return undefined;
}
