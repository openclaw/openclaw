import type { PluginCatalogEntry } from "../../packages/gateway-protocol/src/schema/plugins.js";
import { getPluginSdkDeprecationUsage } from "./sdk-deprecation-usage.js";

type DeprecatedSdkNotice = NonNullable<PluginCatalogEntry["compatibilityNotices"]>[number];

/** removeAfter is a UTC calendar date; past means the window closed before today. */
function isRemovalDatePast(removalDate: string): boolean {
  return removalDate < new Date().toISOString().slice(0, 10);
}

export function buildPluginSdkDeprecationNotices(pluginId: string): DeprecatedSdkNotice[] {
  const apis = getPluginSdkDeprecationUsage(pluginId);
  if (apis.length === 0) {
    return [];
  }
  const removalDate = apis
    .flatMap((api) => (api.removeAfter ? [api.removeAfter] : []))
    .toSorted()[0];
  const formattedDate = removalDate
    ? new Date(`${removalDate}T00:00:00Z`).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      })
    : undefined;
  const message =
    removalDate && formattedDate
      ? isRemovalDatePast(removalDate)
        ? `Uses OpenClaw APIs whose migration date passed on ${formattedDate}. The APIs remain available; plugin authors should migrate. See the migration guide.`
        : `Uses OpenClaw APIs that retire on ${formattedDate}. It keeps working until then; check for a plugin update.`
      : "Uses older OpenClaw APIs. It keeps working for now; check for a plugin update.";
  return [
    {
      code: "deprecated-sdk-api",
      severity: "info",
      message,
      ...(removalDate ? { removalDate } : {}),
      migrationGuideUrl: "https://docs.openclaw.ai/plugins/sdk-migration/how-to-migrate",
      apis: apis.toSorted((left, right) => left.displayName.localeCompare(right.displayName)),
    },
  ];
}
