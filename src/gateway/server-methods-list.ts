import { listLoadedChannelPlugins } from "../channels/plugins/registry-loaded.js";
import { GATEWAY_EVENT_UPDATE_AVAILABLE } from "./events.js";
import { listCoreAdvertisedGatewayMethodNames } from "./methods/core-descriptors.js";
import { GATEWAY_AUX_METHODS } from "./server-aux-methods.js";

export type GatewayMethodChannelPlugin = {
  gatewayMethods?: readonly string[];
  gatewayMethodDescriptors?: readonly { name: string }[];
};

export function listPluginGatewayMethodNames(plugin: GatewayMethodChannelPlugin): string[] {
  const methods: string[] = [];
  let methodCount = 0;
  try {
    methodCount = plugin.gatewayMethods?.length ?? 0;
  } catch {
    // Gateway method advertisements are plugin-owned metadata. A malformed
    // plugin row must not prevent clients from seeing healthy methods.
  }
  for (let index = 0; index < methodCount; index += 1) {
    try {
      const method = plugin.gatewayMethods?.[index];
      if (typeof method === "string") {
        methods.push(method);
      }
    } catch {
      // Skip only the unreadable plugin method row.
    }
  }
  let descriptorCount = 0;
  try {
    descriptorCount = plugin.gatewayMethodDescriptors?.length ?? 0;
  } catch {
    // Keep legacy names above even when descriptor metadata is malformed.
  }
  for (let index = 0; index < descriptorCount; index += 1) {
    try {
      const descriptor = plugin.gatewayMethodDescriptors?.[index];
      const name = descriptor?.name;
      if (typeof name === "string") {
        methods.push(name);
      }
    } catch {
      // Skip only the unreadable plugin descriptor row.
    }
  }
  return methods;
}

/** Lists core methods intentionally advertised to gateway clients. */
export function listCoreGatewayMethods(): string[] {
  return listCoreAdvertisedGatewayMethodNames();
}

function listChannelGatewayMethods(): string[] {
  const methods: string[] = [];
  for (const plugin of listLoadedChannelPlugins() as GatewayMethodChannelPlugin[]) {
    // Plugins may still expose legacy names while newer plugins expose descriptors.
    // Merge both so method discovery stays compatible during descriptor adoption.
    methods.push(...listPluginGatewayMethodNames(plugin));
  }
  return methods;
}

/** Returns the de-duplicated gateway method catalog advertised through method-list APIs. */
export function listGatewayMethods(): string[] {
  return Array.from(
    new Set([...listCoreGatewayMethods(), ...GATEWAY_AUX_METHODS, ...listChannelGatewayMethods()]),
  );
}

/** Gateway event names that clients can subscribe to or receive over the wire. */
export const GATEWAY_EVENTS = [
  "connect.challenge",
  "agent",
  "chat",
  "session.message",
  "session.operation",
  "session.tool",
  "sessions.changed",
  "presence",
  "tick",
  "talk.mode",
  "talk.event",
  "shutdown",
  "health",
  "heartbeat",
  "cron",
  "node.pair.requested",
  "node.pair.resolved",
  "node.invoke.request",
  "device.pair.requested",
  "device.pair.resolved",
  "voicewake.changed",
  "voicewake.routing.changed",
  "exec.approval.requested",
  "exec.approval.resolved",
  "plugin.approval.requested",
  "plugin.approval.resolved",
  GATEWAY_EVENT_UPDATE_AVAILABLE,
];
