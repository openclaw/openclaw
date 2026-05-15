import { listLoadedChannelPlugins } from "../channels/plugins/registry-loaded.js";
import { GATEWAY_EVENT_UPDATE_AVAILABLE } from "./events.js";
import {
  createCoreGatewayMethodDescriptors,
  createGatewayMethodRegistry,
} from "./methods/registry.js";
import { GATEWAY_AUX_METHODS } from "./server-aux-methods.js";
import { coreGatewayHandlers } from "./server-methods.js";

type GatewayMethodChannelPlugin = {
  gatewayMethods?: readonly string[];
  gatewayMethodDescriptors?: readonly { name: string }[];
};

export function listCoreGatewayMethods(): string[] {
  return createGatewayMethodRegistry(
    createCoreGatewayMethodDescriptors(coreGatewayHandlers),
  ).listAdvertisedMethods();
}

export function listGatewayMethods(): string[] {
  const channelMethods = (listLoadedChannelPlugins() as GatewayMethodChannelPlugin[]).flatMap(
    (plugin) => [
      ...(plugin.gatewayMethods ?? []),
      ...(plugin.gatewayMethodDescriptors ?? []).map((descriptor) => descriptor.name),
    ],
  );
  return Array.from(
    new Set([...listCoreGatewayMethods(), ...GATEWAY_AUX_METHODS, ...channelMethods]),
  );
}

export const GATEWAY_EVENTS = [
  "connect.challenge",
  "agent",
  "chat",
  "session.message",
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
