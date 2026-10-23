import { GATEWAY_SERVER_CAPS } from "../../../packages/gateway-protocol/src/server-capabilities.js";
import { getRuntimeConfig } from "../../config/io.runtime.js";
import { resolveStateDir } from "../../config/paths.js";
import { createRuntimeConfig } from "./runtime-config.js";
import { createRuntimeLlmFacade } from "./runtime-llm-facade.js";
import { createRuntimeSystem } from "./runtime-system.js";
import type { PluginRuntimeBase, PluginRuntime } from "./types.js";

const COMMAND_NATIVE_SUBAGENTS_CAPABILITY = "command-native-subagents-v1";
const NATIVE_SUBAGENT_LIST_CAPABILITY = "native-subagent-list-v1";
/** Probe before registering a command that requests `runtimeCapabilities: ["scheduledTurns"]`. */
const COMMAND_SCHEDULED_TURNS_CAPABILITY = "command-scheduled-turns-v1";
/** Accepted command schedules survive a Gateway restart; plugins need not re-enroll them. */
const COMMAND_SCHEDULED_TURNS_RESTART_CAPABILITY = "command-scheduled-turns-restart-v1";

function unavailable(method: string): () => never {
  return () => {
    throw new Error(`${method} is only available through the plugin runtime proxy.`);
  };
}

/** Host-owned facades survive later path-loaded runtime materialization unchanged. */
export function createRuntimeBase(): PluginRuntimeBase {
  let system: PluginRuntime["system"] | undefined;
  return {
    capabilities: Object.freeze([
      GATEWAY_SERVER_CAPS.SENDER_RESTRICTED_HIDDEN_HELPERS,
      COMMAND_NATIVE_SUBAGENTS_CAPABILITY,
      "requester-model-catalog-v1",
      NATIVE_SUBAGENT_LIST_CAPABILITY,
      "native-subagent-profiles-v1",
      COMMAND_SCHEDULED_TURNS_CAPABILITY,
      COMMAND_SCHEDULED_TURNS_RESTART_CAPABILITY,
      "channel-ingress-transform-v1",
    ]),
    config: createRuntimeConfig(),
    llm: createRuntimeLlmFacade(getRuntimeConfig),
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
