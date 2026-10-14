import { GATEWAY_SERVER_CAPS } from "../../../packages/gateway-protocol/src/server-capabilities.js";
import { resolveStateDir } from "../../config/paths.js";
import { createRuntimeConfig } from "./runtime-config.js";
import { createRuntimeSystem } from "./runtime-system.js";
import type { PluginRuntime } from "./types.js";

function unavailable(method: string): () => never {
  return () => {
    throw new Error(`${method} is only available through the plugin runtime proxy.`);
  };
}

/** Host-owned facades survive later path-loaded runtime materialization unchanged. */
export function createRuntimeBase(): Pick<
  PluginRuntime,
  "capabilities" | "config" | "state" | "system"
> {
  let system: PluginRuntime["system"] | undefined;
  return {
    capabilities: Object.freeze([GATEWAY_SERVER_CAPS.SENDER_RESTRICTED_HIDDEN_HELPERS]),
    config: createRuntimeConfig(),
    // Only the registry proxy grants storage, never the base runtime directly.
    state: {
      resolveStateDir,
      openBlobStore: unavailable("openBlobStore"),
      openKeyedStore: unavailable("openKeyedStore"),
      openKeyedStoreV2: unavailable("openKeyedStoreV2"),
      openSyncKeyedStore: unavailable("openSyncKeyedStore"),
      openChannelIngressQueue: unavailable("openChannelIngressQueue"),
      openChannelIngressDrain: unavailable("openChannelIngressDrain"),
    },
    get system() {
      return (system ??= createRuntimeSystem());
    },
  };
}
