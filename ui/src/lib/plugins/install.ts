// Chat loads the shared catalog barrel at startup. Keep install-only schema imports here
// so opening chat does not load the plugin install validation graph.
import { Check } from "typebox/value";
import {
  PluginsInstallProgressEventSchema,
  type PluginInstallActivity,
} from "../../../../packages/gateway-protocol/src/schema/plugins.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { PluginInstallRequest, PluginMutationResult } from "./index.ts";

export async function installPlugin(
  client: GatewayBrowserClient,
  request: PluginInstallRequest,
  onActivity?: (activity: PluginInstallActivity) => void,
): Promise<PluginMutationResult> {
  let requestId: string | undefined;
  const unsubscribe = onActivity
    ? client.addEventListener((event) => {
        if (
          event.event === "plugins.install.progress" &&
          Check(PluginsInstallProgressEventSchema, event.payload) &&
          event.payload.requestId === requestId
        ) {
          onActivity(event.payload);
        }
      })
    : undefined;
  try {
    return await client.request<PluginMutationResult>("plugins.install", request, {
      onSent: (id) => {
        requestId = id;
      },
    });
  } finally {
    unsubscribe?.();
  }
}
