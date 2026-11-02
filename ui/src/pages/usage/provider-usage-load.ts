// Provider plans can wait on provider APIs, so they load beside session usage,
// never ahead of it; the newest request owns the result.
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { requestProviderUsage } from "../../lib/provider-usage-request.ts";
import type { ProviderUsageSummary } from "./data-types.ts";

export function createProviderUsageLoader(options: {
  client: () => GatewayBrowserClient | null;
  isCurrent: (epoch: unknown) => boolean;
  epoch: () => unknown;
  onResult: (epoch: unknown) => void;
  onSettled: () => void;
}) {
  let active: AbortController | null = null;
  // A read cut short by a disconnect resumes on reconnect even when sessions are fresh.
  let interrupted = false;
  let summary: ProviderUsageSummary | null = null;
  let unavailable = false;
  let incomplete = false;
  const cancel = () => {
    interrupted ||= active !== null;
    active?.abort();
    active = null;
  };
  return {
    /** The last complete snapshot; a refreshing or failed read keeps it. */
    get summary() {
      return summary;
    },
    get unavailable() {
      return unavailable;
    },
    get incomplete() {
      return incomplete;
    },
    reset() {
      summary = null;
      unavailable = false;
      incomplete = false;
    },
    cancel,
    resume(): Promise<void> {
      return interrupted ? this.load() : Promise.resolve();
    },
    async load(): Promise<void> {
      const client = options.client();
      if (!client) {
        return;
      }
      cancel();
      interrupted = false;
      const request = new AbortController();
      active = request;
      const epoch = options.epoch();
      try {
        const result = await requestProviderUsage(client, { signal: request.signal });
        if (active === request && options.isCurrent(epoch)) {
          unavailable = !result.ok;
          incomplete = !result.ok || result.value.refreshing === true;
          if (result.ok && !incomplete) {
            summary = result.value;
          }
          options.onResult(epoch);
        }
      } catch {
        // An aborted or failed read leaves the previous plans visible.
      } finally {
        if (active === request) {
          active = null;
          options.onSettled();
        }
      }
    },
  };
}
