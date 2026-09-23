import { hasHttpUrlPrefix } from "@openclaw/net-policy/url-protocol";
export function resolveCronWebhookDeliveryError(deliveryTo: string): string | undefined {
  const target = deliveryTo.trim();
  if (!target) {
    return "cron.errors.webhookUrlRequired";
  }
  // Preserve the form's literal prefix requirement; URL also accepts shorthand.
  if (!hasHttpUrlPrefix(target)) {
    return "cron.errors.webhookUrlInvalid";
  }
  try {
    const parsed = new URL(target);
    return parsed.username || parsed.password || parsed.hostname.includes("%")
      ? "cron.errors.webhookUrlInvalid"
      : undefined;
  } catch {
    return "cron.errors.webhookUrlInvalid";
  }
}
