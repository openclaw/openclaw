import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { PluginsUiDescriptorsResult } from "../../../packages/gateway-protocol/src/schema/plugins.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";

const requests = new WeakMap<GatewayBrowserClient, object>();

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
  let generation: number;
  if (event.event === "plugins.controlUi.changed") {
    if (typeof payload?.revision !== "string" || !payload.revision) {
      return;
    }
    // UI policy can change the advertised widgets without replacing backend plugins.
    generation = current.pluginCapabilities?.generation ?? 0;
  } else {
    const nextGeneration = payload?.generation;
    if (
      event.event !== "plugins.changed" ||
      typeof nextGeneration !== "number" ||
      !Number.isSafeInteger(nextGeneration) ||
      nextGeneration < 0 ||
      nextGeneration <= (current.pluginCapabilities?.generation ?? -1)
    ) {
      return;
    }
    generation = nextGeneration;
  }
  const request = {};
  requests.set(client, request);
  let capabilities: Required<PluginsUiDescriptorsResult>;
  try {
    capabilities = await client.request("plugins.uiDescriptors", {});
  } catch (error) {
    if (requests.get(client) === request) {
      throw error;
    }
    return;
  }
  const snapshot = requests.get(client) === request ? readCurrent() : null;
  if (!snapshot?.hello) {
    return;
  }
  if (
    capabilities.generation < Math.max(generation, snapshot.pluginCapabilities?.generation ?? -1)
  ) {
    throw new Error("Plugin capabilities did not reach the applied generation.");
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
