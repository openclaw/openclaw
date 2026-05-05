import fs from "node:fs";
import { getRuntimeConfig } from "../../config/config.js";
import {
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
} from "../../config/sessions/paths.js";
import { loadSessionStore } from "../../config/sessions/store.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveGatewaySessionStoreTarget } from "../../gateway/session-utils.js";
import { logVerbose } from "../../globals.js";
import {
  getSessionBindingService,
  type ConversationRef,
  type SessionBindingRecord,
} from "../../infra/outbound/session-binding-service.js";
import type { ResolvedAgentRoute } from "../../routing/resolve-route.js";
import { deriveLastRoutePolicy } from "../../routing/resolve-route.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { resolveConfiguredBinding } from "./binding-registry.js";
import { ensureConfiguredBindingTargetReady } from "./binding-targets.js";
import type { ConfiguredBindingResolution } from "./binding-types.js";

const CONFIGURED_BINDING_ROUTE_READY_TIMEOUT_MS = 30_000;

export type ConfiguredBindingRouteResult = {
  bindingResolution: ConfiguredBindingResolution | null;
  route: ResolvedAgentRoute;
  boundSessionKey?: string;
  boundAgentId?: string;
};

export type RuntimeConversationBindingRouteResult = {
  bindingRecord: SessionBindingRecord | null;
  route: ResolvedAgentRoute;
  boundSessionKey?: string;
  boundAgentId?: string;
};

type RuntimeBindingTargetValidator = (params: {
  targetSessionKey: string;
  bindingRecord: SessionBindingRecord;
}) => boolean;

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

function isRuntimeBindingTargetPresent(params: {
  targetSessionKey: string;
  cfg?: OpenClawConfig;
}): boolean {
  try {
    const cfg = params.cfg ?? getRuntimeConfig();
    const target = resolveGatewaySessionStoreTarget({ cfg, key: params.targetSessionKey });
    const store = loadSessionStore(target.storePath, { skipCache: true });
    for (const storeKey of target.storeKeys) {
      const entry = store[storeKey];
      if (!entry?.sessionId) {
        continue;
      }
      const transcriptPath = resolveSessionFilePath(
        entry.sessionId,
        entry,
        resolveSessionFilePathOptions({ storePath: target.storePath }),
      );
      if (fs.existsSync(transcriptPath)) {
        return true;
      }
    }
  } catch (err) {
    logVerbose(
      `runtime conversation binding target validation failed for ${params.targetSessionKey}: ${String(
        err,
      )}`,
    );
  }
  return false;
}

function unbindStaleRuntimeBinding(params: {
  bindingRecord: SessionBindingRecord;
  targetSessionKey: string;
}): void {
  const service = getSessionBindingService();
  service
    .unbind({
      bindingId: params.bindingRecord.bindingId,
      targetSessionKey: params.targetSessionKey,
      reason: "stale-session-target",
    })
    .catch((err) =>
      logVerbose(
        `runtime conversation binding stale-target unbind failed for ${params.bindingRecord.bindingId}: ${String(
          err,
        )}`,
      ),
    );
}

function isPluginOwnedRuntimeBindingRecord(record: SessionBindingRecord | null): boolean {
  const metadata = record?.metadata;
  if (!metadata || typeof metadata !== "object") {
    return false;
  }
  return (
    metadata.pluginBindingOwner === "plugin" &&
    typeof metadata.pluginId === "string" &&
    typeof metadata.pluginRoot === "string"
  );
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

export function resolveRuntimeConversationBindingRoute(
  params: {
    route: ResolvedAgentRoute;
    validateBindingTarget?: RuntimeBindingTargetValidator;
  } & ConfiguredBindingRouteConversationInput,
): RuntimeConversationBindingRouteResult {
  const service = getSessionBindingService();
  const bindingRecord = service.resolveByConversation(
    resolveConfiguredBindingConversationRef(params),
  );
  const boundSessionKey = bindingRecord?.targetSessionKey?.trim();
  if (!bindingRecord || !boundSessionKey) {
    return {
      bindingRecord: null,
      route: params.route,
    };
  }

  if (isPluginOwnedRuntimeBindingRecord(bindingRecord)) {
    service.touch(bindingRecord.bindingId);
    return {
      bindingRecord,
      route: params.route,
    };
  }

  const isTargetPresent = (params.validateBindingTarget ?? isRuntimeBindingTargetPresent)({
    targetSessionKey: boundSessionKey,
    bindingRecord,
  });
  if (!isTargetPresent) {
    logVerbose(
      `runtime conversation binding target missing; unbinding ${bindingRecord.bindingId} -> ${boundSessionKey}`,
    );
    unbindStaleRuntimeBinding({ bindingRecord, targetSessionKey: boundSessionKey });
    return {
      bindingRecord: null,
      route: params.route,
    };
  }

  service.touch(bindingRecord.bindingId);

  const boundAgentId = resolveAgentIdFromSessionKey(boundSessionKey) || params.route.agentId;
  return {
    bindingRecord,
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

export async function ensureConfiguredBindingRouteReady(params: {
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
      (err) =>
        logVerbose(`configured binding route ready check rejected after timeout: ${String(err)}`),
    );
    return { ok: false, error: "Configured binding route ready check timed out" };
  } finally {
    clearTimeout(timer);
  }
}
