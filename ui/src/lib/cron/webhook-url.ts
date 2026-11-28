import { hasHttpUrlPrefix } from "@openclaw/net-policy/url-protocol";
export function resolveCronWebhookDeliveryError(deliveryTo: string): string | undefined {
  const target = deliveryTo.trim();
  if (!target) {
    return "cron.errors.webhookUrlRequired";
  }
  // Preserve the form's literal prefix requirement; URL also accepts shorthand.
  if (!hasHttpUrlPrefix(target)) {
    return "cron.errors.webhookUrlProtocol";
  }
  const parsed = URL.parse(target);
  if (!parsed || parsed.hostname.includes("%")) {
    return "cron.errors.webhookUrlInvalid";
  }
  return parsed.username || parsed.password ? "cron.errors.webhookUrlWithCredentials" : undefined;
}
