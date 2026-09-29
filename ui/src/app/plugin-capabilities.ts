import type { GatewayBrowserClient, GatewayEventFrame, GatewayHelloOk } from "../api/gateway.ts";
import { formatUiError } from "../lib/format-error.ts";
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

/** Keep runtime loading lazy and attribute failures only to the captured connection. */
export async function loadAndRefreshPluginCapabilities(
  event: Pick<GatewayEventFrame, "event" | "payload"> | null,
  client: GatewayBrowserClient,
  readCurrent: () => ApplicationGatewaySnapshot | null,
  publish: (patch: Partial<ApplicationGatewaySnapshot>) => void,
  updateCanvas: (url: string | undefined) => void,
): Promise<void> {
  try {
    const { refreshPluginCapabilities } = await import("./plugin-capabilities.runtime.ts");
    await refreshPluginCapabilities(event, client, readCurrent, publish, updateCanvas);
  } catch (error) {
    if (readCurrent()) {
      publish({ lastError: formatUiError(error) });
    }
  }
}
