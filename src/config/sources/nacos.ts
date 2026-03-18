/**
 * Nacos config source adapter: ConfigSource backed by Nacos config API.
 */

import type { ConfigSource } from "./types.js";
import type { NacosConfigClient } from "./nacos-client.js";
import { createNacosConfigClient } from "./nacos-client.js";
import { buildSnapshotFromRaw } from "./snapshot-from-raw.js";

export type CreateNacosConfigSourceOptions = {
  serverAddr: string;
  dataId: string;
  group: string;
  /** Optional Nacos namespace (tenant). */
  tenant?: string;
  env: NodeJS.ProcessEnv;
  /** Optional client for test injection; otherwise created from serverAddr/dataId/group. */
  nacosClient?: NacosConfigClient;
};

/**
 * Create a ConfigSource that reads config from Nacos (fetch + long-poll subscribe).
 */
export function createNacosConfigSource(opts: CreateNacosConfigSourceOptions): ConfigSource {
  const client =
    opts.nacosClient ??
    createNacosConfigClient({
      serverAddr: opts.serverAddr,
      dataId: opts.dataId,
      group: opts.group,
      tenant: opts.tenant,
    });

  const path = `nacos:${opts.dataId}`;

  return {
    kind: "nacos",
    watchPath: null,
    async readSnapshot() {
      const content = await client.fetchConfig();
      return buildSnapshotFromRaw(content, path, { env: opts.env });
    },
    subscribe(onChange: () => void): () => void {
      return client.subscribe(onChange);
    },
  };
}
