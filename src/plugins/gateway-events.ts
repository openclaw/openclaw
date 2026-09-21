import type { GatewayPluginEventBroadcastFn } from "../gateway/server-broadcast-types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSet } from "../shared/global-singleton.js";
import type { PluginRuntimeCapabilityLease } from "./capability-lease.js";
import { isPluginJsonValue, type PluginJsonValue } from "./host-hook-json.js";

const log = createSubsystemLogger("plugins");

export type OpenClawPluginGatewayEventScope = "operator.read" | "operator.write" | "operator.admin";

export type OpenClawPluginSessionsChangedEvent = {
  sessionKey: string;
  agentId?: string;
  label?: string;
  displayName?: string;
  reason?: string;
  phase?: string;
};

type SessionsChangedHandler = (event: OpenClawPluginSessionsChangedEvent) => unknown;

const sessionsChangedHandlers = resolveGlobalSet<SessionsChangedHandler>(
  Symbol.for("openclaw.pluginSessionsChangedHandlers"),
  "plugin-registry",
);

export type OpenClawPluginGatewayEvents = {
  emit: (
    event: string,
    payload: PluginJsonValue,
    opts: { scope: OpenClawPluginGatewayEventScope },
  ) => void;
  /**
   * Native plugins can already read full session entries through the injected runtime;
   * this notice only avoids polling and does not widen session access.
   */
  onSessionsChanged: (handler: (event: OpenClawPluginSessionsChangedEvent) => void) => () => void;
};

export function createPluginServiceGatewayEvents({
  pluginId,
  broadcast,
  lease,
}: {
  pluginId: string;
  broadcast?: GatewayPluginEventBroadcastFn;
  lease: PluginRuntimeCapabilityLease;
}): OpenClawPluginGatewayEvents | undefined {
  // The broadcaster owns delivery and sessions.changed scheduling. Without it,
  // omit this capability so plugins can detect absence and choose their fallback.
  if (!broadcast) {
    return undefined;
  }
  return {
    emit: (event, payload, opts) => {
      lease.assertActive("gateway event emitter");
      if (!/^[a-z][a-z0-9_-]*$/u.test(event)) {
        throw new Error(`invalid plugin gateway event name: ${event}`);
      }
      if (!isPluginJsonValue(payload)) {
        throw new Error("plugin gateway event payload must be bounded JSON");
      }
      if (
        opts?.scope !== "operator.read" &&
        opts?.scope !== "operator.write" &&
        opts?.scope !== "operator.admin"
      ) {
        throw new Error("plugin gateway event scope must be an operator scope");
      }
      broadcast(`plugin.${pluginId}.${event}`, payload, opts.scope);
    },
    onSessionsChanged: (handler) => {
      lease.assertActive("gateway event subscriber");
      return lease.retain(subscribePluginSessionsChanged(handler));
    },
  };
}

function subscribePluginSessionsChanged(
  handler: (event: OpenClawPluginSessionsChangedEvent) => void,
): () => void {
  const subscription: SessionsChangedHandler = (event) => handler(event);
  sessionsChangedHandlers.add(subscription);
  return () => {
    sessionsChangedHandlers.delete(subscription);
  };
}

export function hasPluginSessionsChangedSubscribers(): boolean {
  return sessionsChangedHandlers.size > 0;
}

export function queuePluginSessionsChanged(payload: unknown): void {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return;
  }
  const source = payload as Record<string, unknown>;
  if (typeof source.sessionKey !== "string" || source.sessionKey.length === 0) {
    return;
  }
  if (sessionsChangedHandlers.size === 0) {
    return;
  }
  const subscriptions = [...sessionsChangedHandlers];
  const event: OpenClawPluginSessionsChangedEvent = {
    sessionKey: source.sessionKey,
    ...(typeof source.agentId === "string" ? { agentId: source.agentId } : {}),
    ...(typeof source.label === "string" ? { label: source.label } : {}),
    ...(typeof source.displayName === "string" ? { displayName: source.displayName } : {}),
    ...(typeof source.reason === "string" ? { reason: source.reason } : {}),
    ...(typeof source.phase === "string" ? { phase: source.phase } : {}),
  };
  queueMicrotask(() => {
    for (const handler of subscriptions) {
      if (!sessionsChangedHandlers.has(handler)) {
        continue;
      }
      try {
        const result = handler(event);
        void Promise.resolve(result).catch((error: unknown) => {
          log.warn(`plugin sessions.changed handler failed: ${String(error)}`);
        });
      } catch (error) {
        log.warn(`plugin sessions.changed handler failed: ${String(error)}`);
      }
    }
  });
}
