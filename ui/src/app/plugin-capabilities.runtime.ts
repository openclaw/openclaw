import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { PluginsUiDescriptorsResult } from "../../../packages/gateway-protocol/src/schema/plugins.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";

/** Load a complete published surface while preserving the current connection and session. */
export async function refreshPluginCapabilities(
  event: Pick<GatewayEventFrame, "event" | "payload">,
  client: GatewayBrowserClient,
  readCurrent: () => ApplicationGatewaySnapshot | null,
  publish: (snapshot: ApplicationGatewaySnapshot) => void,
  updateCanvas: (url: string | undefined) => void,
): Promise<void> {
  const current = readCurrent();
  if (!current) {
    return;
  }
  const payload = isRecord(event.payload) ? event.payload : undefined;
  if (event.event === "plugins.controlUi.changed") {
    if (typeof payload?.revision !== "string" || !payload.revision) {
      return;
    }
  } else {
    const nextGeneration = payload?.generation;
    if (
      event.event !== "plugins.changed" ||
      typeof nextGeneration !== "number" ||
      !Number.isSafeInteger(nextGeneration) ||
      nextGeneration < 0
    ) {
      return;
    }
  }
  const capabilities = await client.request<Required<PluginsUiDescriptorsResult>>(
    "plugins.uiDescriptors",
    {},
  );
  const snapshot = readCurrent();
  if (!snapshot?.hello) {
    return;
  }
  const canvasPluginSurfaceUrl = capabilities.pluginSurfaceUrls.canvas?.trim() || null;
  if (canvasPluginSurfaceUrl !== snapshot.canvasPluginSurfaceUrl) {
    updateCanvas(canvasPluginSurfaceUrl ?? undefined);
  }
  // Hello identity is the transport epoch for pending navigation and session work.
  // Only capability fields change here; a fresh outer snapshot notifies their readers.
  Object.assign(snapshot.hello, {
    features: { ...snapshot.hello.features, methods: capabilities.methods },
    controlUiTabs: capabilities.controlUiTabs,
    controlUiWidgetKinds: capabilities.controlUiWidgetKinds,
    controlUiLinkReaders: capabilities.controlUiLinkReaders,
    pluginSurfaceUrls: capabilities.pluginSurfaceUrls,
  });
  publish({ ...snapshot, pluginCapabilities: capabilities, canvasPluginSurfaceUrl });
}
