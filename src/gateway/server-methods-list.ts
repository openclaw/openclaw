// Gateway method/event catalog.
// Lists advertised core, auxiliary, channel plugin methods, and websocket events.
import { listLoadedChannelPlugins } from "../channels/plugins/registry-loaded.js";
import { listCoreAdvertisedGatewayMethodNames } from "./methods/core-method-policy.js";

function listChannelGatewayMethods(): string[] {
  const methods: string[] = [];
  for (const plugin of listLoadedChannelPlugins()) {
    // Plugins may still expose legacy names while newer plugins expose descriptors.
    // Merge both so method discovery stays compatible during descriptor adoption.
    methods.push(...(plugin.gatewayMethods ?? []));
    for (const descriptor of plugin.gatewayMethodDescriptors ?? []) {
      methods.push(descriptor.name);
    }
  }
  return methods;
}

/** Returns the de-duplicated gateway method catalog advertised through method-list APIs. */
export function listGatewayMethods(): string[] {
  return Array.from(
    new Set([...listCoreAdvertisedGatewayMethodNames(), ...listChannelGatewayMethods()]),
  );
}
