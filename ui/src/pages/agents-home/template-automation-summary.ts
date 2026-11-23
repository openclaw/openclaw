import { createSessionAutomationSchedule } from "../../lib/cron/session-automation-schedule-loader.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { TemplateCatalogDetail } from "./templates-catalog-client.ts";

/** A declared automation's schedule in words, its time zone and whether it starts enabled. */
export function createTemplateAutomationSummary() {
  const schedule = createSessionAutomationSchedule();
  return (item: TemplateCatalogDetail["contents"]["automations"][number]): string =>
    [
      schedule({ kind: "cron", expr: item.schedule, tz: item.timezone }),
      item.timezone,
      t(
        item.enabled ? "templatesCatalog.automationEnabled" : "templatesCatalog.automationDisabled",
      ),
    ].join(" · ");
}
