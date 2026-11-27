import { createSessionAutomationSchedule } from "../../lib/cron/session-automation-schedule-loader.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { TemplateCatalogDetail } from "./templates-catalog-client.ts";

/** A declared automation's schedule in words, its time zone and whether it starts enabled. */
export function createTemplateAutomationSummary() {
  const schedule = createSessionAutomationSchedule();
  // Preview a new Add using the same browser zone sent in the Gateway handshake.
  const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (item: TemplateCatalogDetail["contents"]["automations"][number]): string => {
    const tz = deviceZone || item.timezone;
    return [
      schedule({ kind: "cron", expr: item.schedule, tz }),
      tz,
      t(
        item.enabled ? "templatesCatalog.automationEnabled" : "templatesCatalog.automationDisabled",
      ),
    ].join(" · ");
  };
}
