// Mirrors the server-side cron webhook boundary (src/cron/webhook-url.ts,
// normalizeHttpWebhookUrl): the form must reject the same values the gateway
// refuses at save time, instead of only checking the scheme prefix (issue #146448).
function isValidCronWebhookUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username) {
      return false;
    }
    return !parsed.password;
  } catch {
    return false;
  }
}

/** Resolves the delivery-target error key for a webhook delivery form, if any. */
export function resolveCronWebhookDeliveryError(deliveryTo: string): string | undefined {
  const target = deliveryTo.trim();
  if (!target) {
    return "cron.errors.webhookUrlRequired";
  }
  if (!isValidCronWebhookUrl(target)) {
    return "cron.errors.webhookUrlInvalid";
  }
  return undefined;
}
