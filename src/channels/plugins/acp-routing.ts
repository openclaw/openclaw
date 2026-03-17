import type {
  ConfiguredAcpBindingChannel,
  ResolvedConfiguredAcpBinding,
} from "../../acp/persistent-bindings.types.js";
import { toResolvedConfiguredAcpBinding } from "../../acp/persistent-bindings.types.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { ConversationRef } from "../../infra/outbound/session-binding-service.js";
import type { ResolvedAgentRoute } from "../../routing/resolve-route.js";
import { ensureConfiguredAcpBindingReady } from "./acp-binding-sessions.js";
import { resolveConfiguredBindingRoute } from "./binding-routing.js";

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
  const resolved = resolveConfiguredBindingRoute(params);
  return {
    configuredBinding: resolved.bindingResolution
      ? toResolvedConfiguredAcpBinding(resolved.bindingResolution.record)
      : null,
    route: resolved.route,
    ...(resolved.boundSessionKey ? { boundSessionKey: resolved.boundSessionKey } : {}),
    ...(resolved.boundAgentId ? { boundAgentId: resolved.boundAgentId } : {}),
  };
}

export async function ensureConfiguredAcpRouteReady(params: {
  cfg: OpenClawConfig;
  configuredBinding: ResolvedConfiguredAcpBinding | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  return await ensureConfiguredAcpBindingReady(params);
}

export { ensureConfiguredBindingRouteReady } from "./binding-routing.js";
export { resolveConfiguredBindingRoute } from "./binding-routing.js";
