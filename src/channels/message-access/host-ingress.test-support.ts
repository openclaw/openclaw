import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import {
  captureActivePluginRegistrySnapshot,
  rollbackStagedPluginRegistry,
  stageActivePluginRegistry,
} from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  buildChannelInboundEventContext,
  type BuildChannelInboundEventContextAsyncParams,
  type BuildChannelInboundEventContextParams,
  type BuiltChannelInboundEventContext,
} from "../inbound-event/context.js";
import { createHostChannelInboundEventContextBuilder } from "../inbound-event/host-context-builder.js";
import type { ChannelPlugin } from "../plugins/types.public.js";
import type { ResolveStableChannelMessageIngressParams } from "./runtime-types.js";
import { createHostChannelIngressRuntime } from "./runtime.js";

export async function withTestChannelRegistry<T>(
  plugin: ChannelPlugin | undefined,
  run: () => Promise<T>,
) {
  const previous = plugin ? captureActivePluginRegistrySnapshot() : undefined;
  if (plugin) {
    const registry = createTestRegistry([{ pluginId: plugin.id, plugin, source: "test" }]);
    stageActivePluginRegistry(registry, null, "default");
  }
  try {
    return await run();
  } finally {
    if (previous) {
      rollbackStagedPluginRegistry(previous);
    }
  }
}

export function createHostIngressFixture(
  channelId = "test",
  cfg: OpenClawConfig = {},
  fields: Partial<GatewayRequestContext> = {},
) {
  let live = true;
  // The synthetic Gateway supplies only config and explicitly requested services.
  let gateway = { getRuntimeConfig: () => cfg, ...fields } as GatewayRequestContext;
  const owner = { channelId, isLive: () => live, resolveGatewayContext: () => gateway };
  const ingress = createHostChannelIngressRuntime(owner);
  const build = createHostChannelInboundEventContextBuilder(buildChannelInboundEventContext, owner);
  function buildContext(
    input: BuildChannelInboundEventContextAsyncParams,
  ): Promise<BuiltChannelInboundEventContext>;
  function buildContext(
    input: BuildChannelInboundEventContextParams,
  ): BuiltChannelInboundEventContext;
  function buildContext(input: BuildChannelInboundEventContextParams) {
    return build(input);
  }
  return {
    owner,
    ingress,
    buildContext,
    get gateway() {
      return gateway;
    },
    replaceGatewayContext: (replacement = { ...gateway }) => {
      gateway = replacement;
    },
    retire: () => {
      live = false;
    },
  };
}

export function ingressMessage(
  channel: string,
  sessionKey: string,
  senderId: string,
  overrides: Partial<BuildChannelInboundEventContextParams> = {},
): BuildChannelInboundEventContextParams {
  return {
    channel,
    accountId: "default",
    messageId: senderId,
    from: `${channel}:${senderId}`,
    sender: { id: senderId },
    conversation: { kind: "direct", id: "conversation" },
    route: { agentId: "main", routeSessionKey: sessionKey },
    reply: { to: `${channel}:${senderId}` },
    message: { rawBody: "hello" },
    ...overrides,
  };
}

export function ingressInput(
  message: BuildChannelInboundEventContextParams,
  overrides: Partial<ResolveStableChannelMessageIngressParams> = {},
): ResolveStableChannelMessageIngressParams {
  return {
    channelId: message.channel,
    accountId: message.accountId ?? "default",
    subject: { stableId: message.sender.id },
    conversation: message.conversation,
    contextBinding: {
      agentId: message.route.agentId,
      sessionKey: message.route.routeSessionKey,
      messageId: message.messageId,
      inboundEventKind: "user_request",
    },
    dmPolicy: "open",
    groupPolicy: "disabled",
    allowFrom: ["*"],
    useDefaultPairingStore: false,
    ...overrides,
  };
}
