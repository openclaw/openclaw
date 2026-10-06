import type { GatewayHelloOk } from "../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";

/** Seed only capabilities actually advertised by this hello, never the retired connection. */
export function readHelloPluginCapabilities(
  hello: GatewayHelloOk,
): ApplicationGatewaySnapshot["pluginCapabilities"] {
  if (
    hello.features?.methods === undefined &&
    !hello.controlUiTabs?.length &&
    !hello.controlUiWidgetKinds?.length &&
    !hello.controlUiLinkReaders?.length &&
    !Object.keys(hello.pluginSurfaceUrls ?? {}).length
  ) {
    return null;
  }
  return {
    ok: true,
    descriptors: [],
    methods: hello.features?.methods ?? [],
    controlUiTabs: hello.controlUiTabs ?? [],
    controlUiWidgetKinds: hello.controlUiWidgetKinds ?? [],
    controlUiLinkReaders: hello.controlUiLinkReaders ?? [],
    pluginSurfaceUrls: hello.pluginSurfaceUrls ?? {},
  };
}
