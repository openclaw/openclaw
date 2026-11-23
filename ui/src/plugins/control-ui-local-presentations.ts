import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import type { PluginControlUiModule } from "../../../packages/gateway-protocol/src/schema/plugins.js";
import { gatewayWebSocketTransportUrl } from "../dev-gateway.ts";
import { getSafeLocalStorage } from "../local-storage.ts";
import { controlUiPluginDistributions } from "./control-ui-distribution.ts";

/** Only the serving Gateway's confirmed enabled set is cached. Asset URLs and
 * capabilities always come from this build, never the cache or the response. */
export function packagedLocalPresentations(
  gatewayUrl: string,
  basePath: string,
  confirmed?: readonly string[],
): PluginControlUiModule[] {
  const transport = new URL(gatewayWebSocketTransportUrl(gatewayUrl), location.href);
  transport.protocol = transport.protocol.replace(/^ws/u, "http");
  if (
    transport.origin !== location.origin ||
    transport.pathname.replace(/\/+$/u, "") !== basePath.replace(/\/+$/u, "")
  ) {
    return [];
  }
  const key = "openclaw.control.localPresentations.v1:" + gatewayOriginScope(gatewayUrl);
  let enabled: readonly string[] = confirmed ?? [];
  try {
    const storage = getSafeLocalStorage();
    if (confirmed !== undefined) {
      storage?.setItem(key, JSON.stringify(confirmed));
    } else {
      const saved: unknown = JSON.parse(storage?.getItem(key) ?? "null");
      if (Array.isArray(saved)) {
        enabled = saved.filter((id): id is string => typeof id === "string");
      }
    }
  } catch {
    /* A denied cache never prevents the current online decision. */
  }
  return controlUiPluginDistributions.flatMap((build) =>
    build.activation === "browser-local" &&
    build.bundledDistribution &&
    enabled.includes(build.pluginId)
      ? [
          {
            pluginId: build.pluginId,
            name: build.pluginId,
            revision: build.revision,
            bundledDistribution: build.bundledDistribution,
            activation: "browser-local" as const,
            entryUrl: build.entry,
            styles: build.styles,
          },
        ]
      : [],
  );
}
