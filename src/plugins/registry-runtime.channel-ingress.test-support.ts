import {
  buildChannelInboundEventContext,
  type BuildChannelInboundEventContextParams as ContextParams,
} from "../channels/inbound-event/context.js";
import {
  consumeChannelAdmissionEvidence,
  readChannelContextAdmissionEvidence,
  type ChannelAdmissionAudit,
} from "../channels/message-access/admission-evidence.js";
import type { ResolvedChannelMessageIngress } from "../channels/message-access/runtime-types.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type {
  GatewayContextResolver,
  GatewayRequestContext,
} from "../gateway/server-methods/types.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import { markPluginRegistryActive } from "./registry-lifecycle.js";
import { createPluginRegistry } from "./registry.js";
import { bindGatewayContextResolver } from "./runtime/gateway-request-scope.js";
import type { PluginRuntime } from "./runtime/types.js";
import { createPluginRecord } from "./status.test-fixtures.js";
import type { OpenClawPluginApi } from "./types.js";

type IngressParams = Parameters<PluginRuntime["channel"]["inbound"]["ingress"]["resolveStable"]>[0];
const sessionKey = "agent:main:channel-owner:dm:dm-1";

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
  const builder = createPluginRegistry({
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
  const api = builder.createApi(record, { config: {}, registrationMode: "full" });
  const instance = getPluginInstance(record);
  if (params.prepare && !instance) {
    throw new Error("Registered API must retain its plugin instance");
  }
  const register = () =>
    api.registerChannel({
      plugin: {
        ...createChannelTestPluginBase({
          id: record.id,
          config: { listAccountIds: () => [], resolveAccount: () => ({ accountId: "default" }) },
        }),
        outbound: { deliveryMode: "direct" },
        gateway: params.prepare?.(api),
      },
    });
  if (params.prepare && instance) {
    instance.run(register);
  } else {
    register();
  }
  builder.registry.plugins.push(record);
  markPluginRegistryActive(builder.registry);
  const resolveChannelRuntime = () => {
    const runtime = builder.registry.channels
      .find((candidate) => candidate.plugin.id === record.id)
      ?.resolveChannelRuntime?.();
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
    registryBuilder: builder,
    resolveBuildContext: () => resolveChannelRuntime().inbound.buildContext,
  };
}

export async function resolveIngressForRuntime(
  runtime: PluginRuntime["channel"],
  participantId: string,
  params: Partial<Pick<IngressParams, "channelId" | "conversation">> & {
    contextBinding?: IngressParams["contextBinding"] & {
      messageId: string;
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
      sessionKey,
      messageId: "message-1",
      inboundEventKind: "user_request",
    },
  });
}

export function contextParams(
  params: Partial<Pick<ContextParams, "conversation" | "route" | "reply" | "messageId">> & {
    ingress: ResolvedChannelMessageIngress | readonly ResolvedChannelMessageIngress[];
    channelId?: string;
    senderId?: string;
    inboundEventKind?: ContextParams["message"]["inboundEventKind"];
  },
): ContextParams {
  return {
    channel: params.channelId ?? "channel-owner",
    accountId: "default",
    from: "test:dm-1",
    sender: { id: params.senderId ?? "person-a" },
    conversation: params.conversation ?? { kind: "direct", id: "dm-1" },
    route: params.route ?? { agentId: "main", routeSessionKey: sessionKey },
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
