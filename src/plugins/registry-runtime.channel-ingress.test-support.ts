import {
  buildChannelInboundEventContext,
  type BuildChannelInboundEventContextParams,
} from "../channels/inbound-event/context.js";
import {
  consumeChannelAdmissionEvidence,
  readChannelContextAdmissionEvidence,
  type ChannelAdmissionAudit,
} from "../channels/message-access/admission-evidence.js";
import type { ResolvedChannelMessageIngress } from "../channels/message-access/runtime-types.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  GatewayContextResolver,
  GatewayRequestContext,
} from "../gateway/server-methods/types.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import { markPluginRegistryActive } from "./registry-lifecycle.js";
import { createPluginRegistry } from "./registry.js";
import { bindGatewayContextResolver } from "./runtime/gateway-request-scope.js";
import type { PluginRuntime } from "./runtime/types.js";
import { createPluginRecord } from "./status.test-fixtures.js";
import type { OpenClawPluginApi } from "./types.js";

export function createRuntimeBuilder(params: {
  origin: PluginOrigin;
  id?: string;
  trustedOfficialInstall?: boolean;
  gatewayContextResolver?: GatewayContextResolver;
  audit?: ChannelAdmissionAudit;
  prepare?: (api: OpenClawPluginApi) => ChannelPlugin["gateway"];
}) {
  const subagent = {} as PluginRuntime["subagent"];
  const context = {
    channelAdmissionAudit: params.audit,
    getRuntimeConfig: () => ({}),
  } as GatewayRequestContext;
  bindGatewayContextResolver(subagent, params.gatewayContextResolver ?? (() => context));
  const registryBuilder = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: {
      channel: { inbound: { buildContext: buildChannelInboundEventContext } },
      subagent,
    } as PluginRuntime,
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({
    id: params.id ?? "channel-owner",
    origin: params.origin,
    trustedOfficialInstall: params.trustedOfficialInstall,
  });
  const api = registryBuilder.createApi(record, {
    config: {} as OpenClawConfig,
    registrationMode: "full",
  });
  const instance = getPluginInstance(record);
  if (params.prepare && !instance) {
    throw new Error("Registered API must retain its plugin instance");
  }
  const register = () => {
    const gateway = params.prepare?.(api);
    api.registerChannel({
      plugin: {
        id: record.id,
        meta: {
          id: record.id,
          label: record.id,
          selectionLabel: record.id,
          docsPath: `/channels/${record.id}`,
          blurb: "test channel",
        },
        capabilities: { chatTypes: ["direct"] },
        config: {
          listAccountIds: () => [],
          resolveAccount: () => ({ accountId: "default" }),
        },
        outbound: { deliveryMode: "direct" },
        gateway,
      },
    });
  };
  if (params.prepare && instance) {
    instance.run(register);
  } else {
    register();
  }
  registryBuilder.registry.plugins.push(record);
  markPluginRegistryActive(registryBuilder.registry);
  const resolveChannelRuntime = () => {
    const registration = registryBuilder.registry.channels.find(
      (candidate) => candidate.plugin.id === record.id,
    );
    const runtime = registration?.resolveChannelRuntime?.();
    if (!runtime) {
      throw new Error(`missing registered channel runtime for ${record.id}`);
    }
    return runtime;
  };
  const runtime = resolveChannelRuntime();
  return {
    api,
    instance,
    buildContext: runtime.inbound.buildContext,
    ingress: runtime.inbound.ingress,
    resolveIngress: (
      participantId: string,
      overrides?: Parameters<typeof resolveIngressForRuntime>[2],
    ) => resolveIngressForRuntime(runtime, participantId, overrides),
    record,
    registryBuilder,
    resolveBuildContext: () => resolveChannelRuntime().inbound.buildContext,
  };
}

export async function resolveIngressForRuntime(
  runtime: PluginRuntime["channel"],
  participantId: string,
  params: {
    channelId?: string;
    conversation?: {
      kind: "direct" | "group" | "channel";
      id: string;
      parentId?: string;
      threadId?: string;
    };
    contextBinding?: {
      agentId: string;
      sessionKey: string;
      messageId: string;
      nativeChannelId?: string;
      inboundEventKind: "user_request" | "room_event";
    };
  } = {},
) {
  return await runtime.inbound.ingress.resolveStable({
    channelId: params.channelId ?? "channel-owner",
    accountId: "default",
    subject: { stableId: participantId },
    conversation: params.conversation ?? { kind: "direct", id: "dm-1" },
    dmPolicy: "allowlist",
    allowFrom: [participantId],
    contextBinding: params.contextBinding ?? {
      agentId: "main",
      sessionKey: "agent:main:channel-owner:dm:dm-1",
      messageId: "message-1",
      inboundEventKind: "user_request",
    },
  });
}

export function contextParams(params: {
  ingress: ResolvedChannelMessageIngress | readonly ResolvedChannelMessageIngress[];
  channelId?: string;
  conversation?: BuildChannelInboundEventContextParams["conversation"];
  route?: BuildChannelInboundEventContextParams["route"];
  reply?: BuildChannelInboundEventContextParams["reply"];
  senderId?: string;
  messageId?: string;
  inboundEventKind?: BuildChannelInboundEventContextParams["message"]["inboundEventKind"];
}): BuildChannelInboundEventContextParams {
  return {
    channel: params.channelId ?? "channel-owner",
    accountId: "default",
    from: "test:dm-1",
    sender: { id: params.senderId ?? "person-a" },
    conversation: params.conversation ?? { kind: "direct", id: "dm-1" },
    route: params.route ?? {
      agentId: "main",
      routeSessionKey: "agent:main:channel-owner:dm:dm-1",
    },
    reply: params.reply ?? { to: "channel-owner:dm-1" },
    messageId: params.messageId ?? "message-1",
    message: {
      rawBody: "hello",
      inboundEventKind: params.inboundEventKind ?? "user_request",
    },
    channelIngress: params.ingress,
  };
}

export function inspect(context: object) {
  return consumeChannelAdmissionEvidence(readChannelContextAdmissionEvidence(context));
}
