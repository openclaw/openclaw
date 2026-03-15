import type { CliDeps } from "../../cli/deps.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveMainSessionKeyFromConfig } from "../../config/sessions.js";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  normalizeHookDispatchSessionKey,
  type HookAgentDispatchPayload,
  type HooksConfigResolved,
} from "../hooks.js";
import { dispatchAgentIngressAction, dispatchWakeIngressAction } from "../ingress-dispatch.js";
import { createHooksRequestHandler, type HookClientIpConfig } from "../server-http.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

export function resolveHookClientIpConfig(cfg: OpenClawConfig): HookClientIpConfig {
  return {
    trustedProxies: cfg.gateway?.trustedProxies,
    allowRealIpFallback: cfg.gateway?.allowRealIpFallback === true,
  };
}

export function createGatewayHooksRequestHandler(params: {
  deps: CliDeps;
  getHooksConfig: () => HooksConfigResolved | null;
  getClientIpConfig: () => HookClientIpConfig;
  bindHost: string;
  port: number;
  logHooks: SubsystemLogger;
}) {
  const { deps, getHooksConfig, getClientIpConfig, bindHost, port, logHooks } = params;

  const dispatchWakeHook = (value: { text: string; mode: "now" | "next-heartbeat" }) => {
    dispatchWakeIngressAction(value, {
      sessionKey: resolveMainSessionKeyFromConfig(),
      heartbeatReason: "hook:wake",
    });
  };

  const dispatchAgentHook = (value: HookAgentDispatchPayload) => {
    return dispatchAgentIngressAction(
      {
        ...value,
        sessionKey: normalizeHookDispatchSessionKey({
          sessionKey: value.sessionKey,
          targetAgentId: value.agentId,
        }),
      },
      {
        deps,
        logger: logHooks,
        mainSessionKey: resolveMainSessionKeyFromConfig(),
      },
    );
  };

  return createHooksRequestHandler({
    getHooksConfig,
    bindHost,
    port,
    logHooks,
    getClientIpConfig,
    dispatchAgentHook,
    dispatchWakeHook,
  });
}
