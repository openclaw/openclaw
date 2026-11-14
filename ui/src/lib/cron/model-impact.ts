import type {
  CronModelImpactParams,
  CronModelImpactResult,
} from "../../../../packages/gateway-protocol/src/schema/cron-model-impact.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { showAutomationModelImpactDialog } from "../../components/automation-model-impact-dialog.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { formatUiError } from "../format-error.ts";
import { registerEnglishCatalog, t } from "../reactive/i18n.ts";

registerEnglishCatalog(registerSettingsEnglish);

/** One read-only assessment for both model settings owners; never edits jobs or routing. */
export async function reviewAutomationModelChange(
  client: Pick<GatewayBrowserClient, "request">,
  target: CronModelImpactParams,
  owner: { isCurrent: () => boolean; onNotice: (notice: string) => void; retired?: Promise<void> },
): Promise<boolean> {
  try {
    owner.onNotice(t("modelProviders.automationModelImpact.checking"));
    const impact = await client.request<CronModelImpactResult>("cron.modelImpact", target);
    if (!owner.isCurrent()) {
      return false;
    }
    const enabled = impact.jobs.filter((job) => job.enabled);
    const warnings = impact.issues.filter((issue) => issue.severity !== "info");
    const notice = [
      t("modelProviders.automationModelImpact.proposed", {
        model: target.model ?? t("modelProviders.automationModelImpact.inherited"),
      }),
      "",
      t("modelProviders.automationModelImpact.enabled", { count: String(enabled.length) }),
      t("modelProviders.automationModelImpact.changed", {
        count: String(enabled.filter((job) => job.changed).length),
      }),
      ...enabled.map((job) =>
        [
          job.name,
          t("modelProviders.automationModelImpact.transition", {
            before: job.before.model ?? t("modelProviders.automationModelImpact.unresolved"),
            after: job.after.model ?? t("modelProviders.automationModelImpact.unresolved"),
          }),
          t("modelProviders.automationModelImpact.status." + job.status),
          ...job.issues.map((issue) => [issue.message, issue.recovery].filter(Boolean).join(" ")),
        ].join(" — "),
      ),
      t("modelProviders.automationModelImpact.disabled", {
        count: String(impact.jobs.length - enabled.length),
      }),
      ...impact.issues.map((issue) => [issue.message, issue.recovery].filter(Boolean).join(" ")),
      t("modelProviders.automationModelImpact.recovery"),
    ].join("\n");
    owner.onNotice(notice);
    if (
      !warnings.length &&
      !impact.jobs.some(
        (job) => job.enabled && (job.status === "blocked" || job.status === "unknown"),
      )
    ) {
      return true;
    }
    const controller = new AbortController();
    void owner.retired?.then(() => controller.abort());
    const confirmed = await showAutomationModelImpactDialog(impact, {
      canConfirm: owner.isCurrent,
      signal: controller.signal,
    });
    if (!confirmed && owner.isCurrent()) {
      owner.onNotice([t("modelProviders.automationModelImpact.canceled"), notice].join("\n\n"));
    }
    return confirmed && owner.isCurrent();
  } catch (error) {
    if (owner.isCurrent()) {
      owner.onNotice(
        t("modelProviders.automationModelImpact.failed", { error: formatUiError(error) }),
      );
    }
    return false;
  }
}
