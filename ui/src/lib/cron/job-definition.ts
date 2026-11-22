import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { CronJob } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";

/** The editor and inline controls update the definition they actually displayed. */
export function patchCronJobDefinition(
  client: GatewayBrowserClient,
  job: Pick<CronJob, "id" | "configRevision">,
  patch: Record<string, unknown>,
): Promise<CronJob> {
  if (!job.configRevision) {
    throw new Error(t("cron.missingConfigRevision"));
  }
  return client.request<CronJob>("cron.update", {
    id: job.id,
    expectedConfigRevision: job.configRevision,
    patch,
  });
}
