import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { CronCompactJob, CronJobsListResult } from "../../api/types.ts";

const catalogs = new WeakMap<GatewayBrowserClient, Promise<CronJobsListResult<CronCompactJob>>>();

/** The Gateway connection and cron/config publications own this fixed search projection. */
export function invalidateCronCatalog(client: GatewayBrowserClient): void {
  catalogs.delete(client);
}

export function loadCronCatalog(
  client: GatewayBrowserClient,
): Promise<CronJobsListResult<CronCompactJob>> {
  let pending = catalogs.get(client);
  if (!pending) {
    pending = client.request<CronJobsListResult<CronCompactJob>>("cron.list", {
      includeDisabled: true,
      limit: 200,
      offset: 0,
      sortBy: "name",
      sortDir: "asc",
      compact: true,
    });
    catalogs.set(client, pending);
    const request = pending;
    void request.catch(() => {
      if (catalogs.get(client) === request) {
        catalogs.delete(client);
      }
    });
  }
  return pending;
}
