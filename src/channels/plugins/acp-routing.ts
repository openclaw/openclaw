import type {
  ConfiguredAcpBindingChannel,
  ResolvedConfiguredAcpBinding,
} from "../../acp/persistent-bindings.types.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { ConversationRef } from "../../infra/outbound/session-binding-service.js";
import type { ResolvedAgentRoute } from "../../routing/resolve-route.js";
import { deriveLastRoutePolicy } from "../../routing/resolve-route.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { ensureConfiguredAcpBindingReady } from "./acp-binding-sessions.js";
import { resolveConfiguredAcpBinding } from "./acp-bindings.js";

type ConfiguredAcpRouteConversationInput =
  | {
      conversation: ConversationRef;
    }
  | {
      channel: ConfiguredAcpBindingChannel;
      accountId: string;
      conversationId: string;
      parentConversationId?: string;
    };

function resolveConfiguredAcpConversationRef(
  params: ConfiguredAcpRouteConversationInput,
): ConversationRef {
  if ("conversation" in params) {
    return params.conversation;
  }
  return {
    channel: params.channel,
    accountId: params.accountId,
    conversationId: params.conversationId,
    parentConversationId: params.parentConversationId,
  };
}

export function resolveConfiguredAcpRoute(
  params: {
    cfg: OpenClawConfig;
    route: ResolvedAgentRoute;
  } & ConfiguredAcpRouteConversationInput,
): {
  configuredBinding: ResolvedConfiguredAcpBinding | null;
  route: ResolvedAgentRoute;
  boundSessionKey?: string;
  boundAgentId?: string;
} {
  const configuredBinding =
    resolveConfiguredAcpBinding({
      cfg: params.cfg,
      conversation: resolveConfiguredAcpConversationRef(params),
    })?.configuredBinding ?? null;
  if (!configuredBinding) {
    return {
      configuredBinding: null,
      route: params.route,
    };
  }
  const boundSessionKey = configuredBinding.record.targetSessionKey?.trim() ?? "";
  if (!boundSessionKey) {
    return {
      configuredBinding,
      route: params.route,
    };
  }
  const boundAgentId = resolveAgentIdFromSessionKey(boundSessionKey) || params.route.agentId;
  return {
    configuredBinding,
    boundSessionKey,
    boundAgentId,
    route: {
      ...params.route,
      sessionKey: boundSessionKey,
      agentId: boundAgentId,
      lastRoutePolicy: deriveLastRoutePolicy({
        sessionKey: boundSessionKey,
        mainSessionKey: params.route.mainSessionKey,
      }),
      matchedBy: "binding.channel",
    },
  };
}

export async function ensureConfiguredAcpRouteReady(params: {
  cfg: OpenClawConfig;
  configuredBinding: ResolvedConfiguredAcpBinding | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  return await ensureConfiguredAcpBindingReady(params);
}
