import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { readSessionBindingInspectionConversation } from "../../infra/outbound/session-binding-normalization.js";
import {
  getSessionBindingService,
  inspectSessionBindingByConversation,
  type ConversationRef,
  type SessionBindingRecord,
} from "../../infra/outbound/session-binding-service.js";
import type { ResolvedAgentRoute } from "../../routing/resolve-route.js";
import { deriveLastRoutePolicy } from "../../routing/resolve-route.js";
import {
  buildAgentMainSessionKey,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import {
  resolveConversationBindingSelection,
  projectConfiguredConversationBindingRouteFacts,
  resolveConversationBindingAgentId,
  withConversationBindingRouteFacts,
} from "../conversation-binding-route-facts.js";
import { ensureConfiguredBindingTargetReady } from "./binding-targets.js";
import type { ConfiguredBindingResolution } from "./binding-types.js";
import { resolveConfiguredBinding } from "./configured-binding-registry.js";

const CONFIGURED_BINDING_ROUTE_READY_TIMEOUT_MS = 30_000;

export type ConfiguredBindingRouteResult = {
  bindingResolution: ConfiguredBindingResolution | null;
  route: ResolvedAgentRoute;
  boundSessionKey?: string;
  boundAgentId?: string;
};

export type RuntimeConversationBindingRouteResult = {
  /** False only when the authoritative channel-owned binding store is temporarily unavailable. */
  bindingOwnerAvailable?: boolean;
  bindingRecord: SessionBindingRecord | null;
  route: ResolvedAgentRoute;
  boundSessionKey?: string;
  boundAgentId?: string;
  pluginId?: string;
};

type RuntimeConversationBindingRouteResolver = (selection: {
  inspection: ReturnType<typeof inspectSessionBindingByConversation>;
  bindingOwnerAvailable: boolean;
  bindingRecord: SessionBindingRecord | null;
  boundAgentId?: string;
}) => ResolvedAgentRoute;

type RuntimeConversationBindingRouteInput =
  | { route: ResolvedAgentRoute; resolveRoute?: never }
  | { route?: never; resolveRoute: RuntimeConversationBindingRouteResolver };

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
  const { channel, accountId, conversationId, parentConversationId } =
    "conversation" in params ? params.conversation : params;
  return {
    channel,
    accountId,
    conversationId,
    ...(parentConversationId !== undefined ? { parentConversationId } : {}),
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
      route: projectConfiguredConversationBindingRouteFacts(params.route),
    };
  }

  const boundSessionKey = bindingResolution.statefulTarget.sessionKey.trim();
  if (!boundSessionKey) {
    return {
      bindingResolution,
      route: projectConfiguredConversationBindingRouteFacts(params.route),
    };
  }
  const boundAgentId = resolveAgentIdFromSessionKey(
    boundSessionKey,
    bindingResolution.statefulTarget.agentId,
  );
  // Configured bindings own the session key, so recompute last-route policy against that target
  // before downstream delivery records the route.
  return {
    bindingResolution,
    boundSessionKey,
    boundAgentId,
    route: projectConfiguredConversationBindingRouteFacts({
      ...params.route,
      sessionKey: boundSessionKey,
      agentId: boundAgentId,
      lastRoutePolicy: deriveLastRoutePolicy({
        sessionKey: boundSessionKey,
        mainSessionKey: params.route.mainSessionKey,
      }),
      matchedBy: "binding.channel",
    }),
  };
}

/** Projects prepared ownership facts without reading or changing binding storage. */
export function inspectRuntimeConversationBindingRoute(
  params: RuntimeConversationBindingRouteInput & {
    inspection: ReturnType<typeof inspectSessionBindingByConversation>;
  },
): RuntimeConversationBindingRouteResult {
  const { inspection } = params;
  const selection = resolveConversationBindingSelection(
    inspection.status === "available" ? inspection.binding : null,
  );
  const bindingRecord = selection.kind === "none" ? null : selection.binding;
  const explicitAgentId =
    selection.kind === "agent"
      ? (parseAgentSessionKey(selection.sessionKey)?.agentId ??
        normalizeOptionalString(selection.binding.metadata?.agentId))
      : undefined;
  const boundAgentId =
    params.resolveRoute && selection.kind === "agent" && explicitAgentId
      ? resolveConversationBindingAgentId(selection.binding, explicitAgentId)
      : undefined;
  const routeSelection = {
    inspection,
    bindingOwnerAvailable: inspection.status === "available",
    bindingRecord,
    boundAgentId,
  };
  const baseRoute = params.resolveRoute ? params.resolveRoute(routeSelection) : params.route;
  const inspectedConversation = readSessionBindingInspectionConversation(inspection);
  if (inspection.status === "unavailable") {
    return {
      bindingOwnerAvailable: false,
      bindingRecord: null,
      route: inspectedConversation
        ? withConversationBindingRouteFacts(
            { ...baseRoute },
            { kind: "unavailable" },
            baseRoute.agentId,
            inspectedConversation,
          )
        : baseRoute,
    };
  }
  const conversation = inspectedConversation ?? inspection.binding?.conversation;
  const observe = (route: ResolvedAgentRoute) =>
    conversation
      ? withConversationBindingRouteFacts(route, selection, baseRoute.agentId, conversation)
      : route;
  if (selection.kind === "none") {
    if (selection.ignoredCronSessionKey) {
      logVerbose(
        `ignored runtime conversation binding to isolated cron run session ${selection.ignoredCronSessionKey}`,
      );
    }
    return {
      bindingOwnerAvailable: true,
      bindingRecord: null,
      route: observe({ ...baseRoute }),
    };
  }
  if (selection.kind === "plugin") {
    return {
      bindingOwnerAvailable: true,
      bindingRecord: selection.binding,
      pluginId: selection.pluginId,
      route: observe({ ...baseRoute }),
    };
  }
  const boundSessionKey = selection.sessionKey;
  const resolvedBoundAgentId = resolveConversationBindingAgentId(
    selection.binding,
    baseRoute.agentId,
  );
  const mainSessionKey =
    resolvedBoundAgentId === baseRoute.agentId
      ? baseRoute.mainSessionKey
      : buildAgentMainSessionKey({
          agentId: resolvedBoundAgentId,
          mainKey: parseAgentSessionKey(baseRoute.mainSessionKey)?.rest,
        });
  const route: ResolvedAgentRoute = {
    ...baseRoute,
    sessionKey: boundSessionKey,
    agentId: resolvedBoundAgentId,
    mainSessionKey,
    lastRoutePolicy: deriveLastRoutePolicy({
      sessionKey: boundSessionKey,
      mainSessionKey,
    }),
    matchedBy: "binding.channel",
  };
  return {
    bindingOwnerAvailable: true,
    bindingRecord,
    boundSessionKey,
    boundAgentId: resolvedBoundAgentId,
    route: observe(route),
  };
}

/**
 * Resolves runtime routing after the binding owner settles its activity mutation.
 * Legacy adapters may still perform synchronous persistence during migration.
 */
export async function resolveRuntimeConversationBindingRouteAsync(
  params: { route: ResolvedAgentRoute } & ConfiguredBindingRouteConversationInput,
): Promise<RuntimeConversationBindingRouteResult> {
  const route = { ...params.route };
  const conversation = resolveConfiguredBindingConversationRef(params);
  const service = getSessionBindingService();
  let result = inspectRuntimeConversationBindingRoute({
    route,
    inspection: await service.inspectByConversationAsync(conversation),
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!result.bindingRecord) {
      return result;
    }
    const { bindingId, boundAt, targetSessionKey, targetKind } = result.bindingRecord;
    const scope = {
      channel: result.bindingRecord.conversation.channel,
      accountId: result.bindingRecord.conversation.accountId,
    };
    await service.touchAsync(bindingId, undefined, scope);
    result = inspectRuntimeConversationBindingRoute({
      route,
      inspection: await service.inspectByConversationAsync(conversation),
    });
    if (
      !result.bindingRecord ||
      (result.bindingRecord.bindingId === bindingId &&
        result.bindingRecord.boundAt === boundAt &&
        result.bindingRecord.targetSessionKey === targetSessionKey &&
        result.bindingRecord.targetKind === targetKind &&
        result.bindingRecord.conversation.channel === scope.channel &&
        result.bindingRecord.conversation.accountId === scope.accountId)
    ) {
      return result;
    }
    // IDs can survive rebinding; a new binding incarnation needs its own activity update.
  }
  throw new Error(
    "Conversation binding changed repeatedly while recording activity. Retry the message.",
  );
}

export function resolveRuntimeConversationBindingRoute(
  params: RuntimeConversationBindingRouteInput & {
    touchBinding?: boolean;
  } & ConfiguredBindingRouteConversationInput,
): RuntimeConversationBindingRouteResult {
  const inspection = inspectSessionBindingByConversation(
    resolveConfiguredBindingConversationRef(params),
  );
  const result = inspectRuntimeConversationBindingRoute({ ...params, inspection });
  if (params.touchBinding !== false && result.bindingRecord) {
    getSessionBindingService().touch(
      result.bindingRecord.bindingId,
      undefined,
      result.bindingRecord.conversation,
    );
  }
  return result;
}

export async function ensureConfiguredBindingRouteReady(params: {
  assertActive?: () => void;
  cfg: OpenClawConfig;
  bindingResolution: ConfiguredBindingResolution | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const readyPromise = ensureConfiguredBindingTargetReady(params);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutToken = Symbol("configured-binding-route-ready-timeout");
  const timeoutPromise = new Promise<typeof timeoutToken>((resolve) => {
    timer = setTimeout(() => resolve(timeoutToken), CONFIGURED_BINDING_ROUTE_READY_TIMEOUT_MS);
    timer.unref?.();
  });

  try {
    const result = await Promise.race([readyPromise, timeoutPromise]);
    if (result !== timeoutToken) {
      return result;
    }
    // Let late driver work finish for diagnostics, but return a bounded failure to the caller.
    logVerbose(
      `configured binding route ready check timed out after ${
        CONFIGURED_BINDING_ROUTE_READY_TIMEOUT_MS / 1_000
      }s`,
    );
    readyPromise.then(
      (lateResult) =>
        logVerbose(
          `configured binding route ready check settled after timeout (ok=${lateResult.ok})`,
        ),
      (err: unknown) =>
        logVerbose(`configured binding route ready check rejected after timeout: ${String(err)}`),
    );
    return { ok: false, error: "Configured binding route ready check timed out" };
  } finally {
    clearTimeout(timer);
  }
}
