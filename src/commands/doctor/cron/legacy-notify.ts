// Repair retired webhook routing without redirecting saved chat delivery.
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeHttpWebhookUrl } from "../../../cron/webhook-url.js";
import { canRepairCronDeliveryForDoctor } from "./store-migration.js";

export function migrateLegacyNotifyFallback(params: {
  jobs: Array<Record<string, unknown>>;
  legacyWebhook?: string;
}) {
  let changed = false;
  const warnings: string[] = [];
  const changes: string[] = [];
  const configuredLegacyWebhook = normalizeOptionalString(params.legacyWebhook);
  const legacyWebhook = normalizeHttpWebhookUrl(configuredLegacyWebhook);

  for (const raw of params.jobs) {
    const id = normalizeOptionalString(raw.id);
    const jobName = normalizeOptionalString(raw.name) ?? id ?? "<unnamed>";
    const delivery = asNullableRecord(raw.delivery);
    const mode = normalizeOptionalLowercaseString(delivery?.mode);
    const completion = asNullableRecord(delivery?.completionDestination);
    const completionUrl = normalizeHttpWebhookUrl(normalizeOptionalString(completion?.to));
    const hasValidCompletion =
      normalizeOptionalLowercaseString(completion?.mode) === "webhook" && completionUrl !== null;
    const hadCompletion = delivery !== null && "completionDestination" in delivery;
    let removedSecondaryUrl = completionUrl;
    let lostActiveSecondary = hadCompletion && mode === "announce" && hasValidCompletion;
    if (hadCompletion) {
      delete delivery.completionDestination;
      changed = true;
    }

    if ("notify" in raw && canRepairCronDeliveryForDoctor(raw.delivery)) {
      const to = normalizeOptionalString(delivery?.to);
      const validWebhookTo = normalizeHttpWebhookUrl(to);
      const hasLegacyChatDelivery =
        mode === undefined &&
        delivery !== null &&
        (normalizeOptionalString(delivery.channel) !== undefined ||
          normalizeOptionalString(delivery.accountId) !== undefined ||
          "threadId" in delivery ||
          (to !== undefined && !validWebhookTo));
      if (raw.notify !== true || (mode === "webhook" && validWebhookTo) || hasValidCompletion) {
        // An explicit webhook already superseded the fallback, or the marker was inert.
        delete raw.notify;
        changed = true;
      } else if (configuredLegacyWebhook && !legacyWebhook) {
        // Keep the marker so doctor can retry after the operator fixes the target.
        warnings.push(
          `Automation "${jobName}" still uses legacy notify fallback, but cron.webhook is not a valid HTTP(S) URL so doctor cannot migrate it automatically.`,
        );
      } else {
        if (
          legacyWebhook &&
          ((mode === undefined && !hasLegacyChatDelivery) || mode === "none" || mode === "webhook")
        ) {
          raw.delivery = {
            ...delivery,
            mode: "webhook",
            to: mode === "none" ? legacyWebhook : (validWebhookTo ?? legacyWebhook),
          };
        } else if (legacyWebhook) {
          // The old migration would have added a secondary POST alongside the chat send.
          if (hasLegacyChatDelivery) {
            raw.delivery = { ...delivery, mode: "announce" };
          }
          removedSecondaryUrl = legacyWebhook;
          lostActiveSecondary = true;
        }
        delete raw.notify;
        changed = true;
      }
    }

    if (hadCompletion || lostActiveSecondary) {
      const label = id && id !== jobName ? `"${jobName}" (${id})` : `"${jobName}"`;
      const target = removedSecondaryUrl
        ? ` to ${new URL(removedSecondaryUrl).hostname}`
        : " (no valid host)";
      const paused = lostActiveSecondary && raw.enabled !== false;
      if (paused) {
        raw.enabled = false;
      }
      const next = paused
        ? "Paused because this automation can no longer send to both chat and the webhook. Review delivery before re-enabling it."
        : "The primary delivery setting is unchanged.";
      changes.push(`Automation ${label}: removed the retired secondary webhook${target}. ${next}`);
    }
  }

  return { changed, warnings, changes };
}
