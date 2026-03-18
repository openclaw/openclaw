/**
 * Nacos config client: fetch config via Open API and long-poll for changes.
 * No nacos npm dependency; plain HTTP only. Uses opts.fetch for test injection.
 */

export type NacosConfigClientOptions = {
  serverAddr: string;
  dataId: string;
  group: string;
  /** Optional tenant (namespace). */
  tenant?: string;
  /** Optional fetch implementation; default globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
};

export type NacosConfigClient = {
  fetchConfig: () => Promise<string>;
  subscribe: (onChange: () => void) => () => void;
};

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

/**
 * Create a Nacos config client. fetchConfig GETs config content;
 * subscribe starts a long-poll loop and calls onChange when the server indicates change.
 */
export function createNacosConfigClient(opts: NacosConfigClientOptions): NacosConfigClient {
  const base = trimTrailingSlash(opts.serverAddr);
  const doFetch = opts.fetch ?? globalThis.fetch;

  const getConfigUrl = (): string => {
    const params = new URLSearchParams({
      dataId: opts.dataId,
      group: opts.group,
    });
    if (opts.tenant) params.set("tenant", opts.tenant);
    return `${base}/nacos/v1/cs/configs?${params.toString()}`;
  };

  const listenerUrl = `${base}/nacos/v1/cs/configs/listener`;

  return {
    async fetchConfig(): Promise<string> {
      const res = await doFetch(getConfigUrl());
      if (!res.ok) {
        throw new Error(`Nacos get config failed: ${res.status} ${res.statusText}`);
      }
      return res.text();
    },

    subscribe(onChange: () => void): () => void {
      let stopped = false;

      const poll = async (): Promise<void> => {
        if (stopped) return;
        const body = new URLSearchParams({
          dataId: opts.dataId,
          group: opts.group,
        });
        if (opts.tenant) body.set("tenant", opts.tenant);
        try {
          const res = await doFetch(listenerUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              "Long-Pulling-Timeout": "30000",
            },
            body: body.toString(),
          });
          if (stopped) return;
          if (res.ok) {
            onChange();
          }
        } catch {
          // Ignore errors; loop will retry or exit when stopped
        }
        if (!stopped) {
          void poll();
        }
      };

      void poll();
      return () => {
        stopped = true;
      };
    },
  };
}
