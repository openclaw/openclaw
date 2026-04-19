import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import type { ConversationRef } from "../../infra/outbound/session-binding-service.js";
import type { ResolvedAgentRoute } from "../../routing/resolve-route.js";
import { deriveLastRoutePolicy } from "../../routing/resolve-route.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { resolveConfiguredBinding } from "./binding-registry.js";
import { ensureConfiguredBindingTargetReady } from "./binding-targets.js";
import type { ConfiguredBindingResolution } from "./binding-types.js";

export type ConfiguredBindingRouteResult = {
  bindingResolution: ConfiguredBindingResolution | null;
  route: ResolvedAgentRoute;
  boundSessionKey?: string;
  boundAgentId?: string;
};

type ConfiguredBindingRouteConversationInput =
  | {
      conversation: ConversationRef;
    }
  | {
      channel: string;
      accountId: string;
      conversationId: string;
      parentConversationId?: string;
    };

function resolveConfiguredBindingConversationRef(
  params: ConfiguredBindingRouteConversationInput,
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

export function resolveConfiguredBindingRoute(
  params: {
    cfg: OpenClawConfig;
    route: ResolvedAgentRoute;
  } & ConfiguredBindingRouteConversationInput,
): ConfiguredBindingRouteResult {
  const bindingResolution =
    resolveConfiguredBinding({
      cfg: params.cfg,
      conversation: resolveConfiguredBindingConversationRef(params),
    }) ?? null;
  if (!bindingResolution) {
    return {
      bindingResolution: null,
      route: params.route,
    };
  }

  const boundSessionKey = bindingResolution.statefulTarget.sessionKey.trim();
  if (!boundSessionKey) {
    return {
      bindingResolution,
      route: params.route,
    };
  }
  const boundAgentId =
    resolveAgentIdFromSessionKey(boundSessionKey) || bindingResolution.statefulTarget.agentId;
  return {
    bindingResolution,
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

const BINDING_ROUTE_READY_TIMEOUT_MS = 30_000;

export async function ensureConfiguredBindingRouteReady(params: {
  cfg: OpenClawConfig;
  bindingResolution: ConfiguredBindingResolution | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const readyP = ensureConfiguredBindingTargetReady(params);
  const token = Symbol("binding-route-ready-timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutP = new Promise<typeof token>((resolve) => {
    timer = setTimeout(() => resolve(token), BINDING_ROUTE_READY_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    const result = await Promise.race([readyP, timeoutP]);
    if (result === token) {
      logVerbose(
        `acp: ensureConfiguredBindingRouteReady timed out after ${BINDING_ROUTE_READY_TIMEOUT_MS / 1_000}s`,
      );
      // Log when the orphaned readyP eventually settles so diagnostics are clear
      readyP.then(
        (late) =>
          logVerbose(
            `acp: binding route ready resolved after timeout (ok=${late.ok})`,
          ),
        (err) =>
          logVerbose(
            `acp: binding route ready rejected after timeout: ${err}`,
          ),
      );
      return { ok: false, error: "Configured ACP binding route ready check timed out" };
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}
