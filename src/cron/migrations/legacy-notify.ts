import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeHttpWebhookUrl } from "../webhook-url.js";

export type LegacyNotifyMigrationOutcome = {
  changed: boolean;
  warnings: string[];
};

export function migrateLegacyNotifyFallback(params: {
  jobs: Array<Record<string, unknown>>;
  legacyWebhook?: string;
}): LegacyNotifyMigrationOutcome {
  let changed = false;
  const warnings: string[] = [];

  for (const raw of params.jobs) {
    if (!("notify" in raw)) {
      continue;
    }

    const jobName =
      normalizeOptionalString(raw.name) ?? normalizeOptionalString(raw.id) ?? "<unnamed>";
    const notify = raw.notify === true;
    if (!notify) {
      delete raw.notify;
      changed = true;
      continue;
    }

    const delivery =
      raw.delivery && typeof raw.delivery === "object" && !Array.isArray(raw.delivery)
        ? (raw.delivery as Record<string, unknown>)
        : null;
    const mode = normalizeOptionalLowercaseString(delivery?.mode);
    const to = normalizeOptionalString(delivery?.to);
    const hasLegacyChatDelivery =
      mode === undefined &&
      delivery !== null &&
      (normalizeOptionalString(delivery.channel) !== undefined ||
        normalizeOptionalString(delivery.accountId) !== undefined ||
        "threadId" in delivery ||
        (to !== undefined && !normalizeHttpWebhookUrl(to)));
    const completionDestination =
      delivery?.completionDestination &&
      typeof delivery.completionDestination === "object" &&
      !Array.isArray(delivery.completionDestination)
        ? (delivery.completionDestination as Record<string, unknown>)
        : null;
    const completionMode = normalizeOptionalLowercaseString(completionDestination?.mode);
    const completionTo = normalizeOptionalString(completionDestination?.to);

    if ((mode === "webhook" && to) || (completionMode === "webhook" && completionTo)) {
      delete raw.notify;
      changed = true;
      continue;
    }

    if ((mode === undefined && !hasLegacyChatDelivery) || mode === "none" || mode === "webhook") {
      if (!params.legacyWebhook) {
        warnings.push(
          `Cron job "${jobName}" still uses legacy notify fallback, but cron.webhook is unset so doctor cannot migrate it automatically.`,
        );
        continue;
      }
      raw.delivery = {
        ...delivery,
        mode: "webhook",
        to: mode === "none" ? params.legacyWebhook : (to ?? params.legacyWebhook),
      };
      delete raw.notify;
      changed = true;
      continue;
    }

    if (params.legacyWebhook) {
      raw.delivery = {
        ...delivery,
        ...(hasLegacyChatDelivery ? { mode: "announce" } : {}),
        completionDestination: {
          ...completionDestination,
          mode: "webhook",
          to: params.legacyWebhook,
        },
      };
      delete raw.notify;
      changed = true;
      continue;
    }

    warnings.push(
      `Cron job "${jobName}" still uses legacy notify fallback, but cron.webhook is unset so doctor cannot migrate it automatically.`,
    );
  }

  return { changed, warnings };
}
