import type { CliDeps } from "../../cli/deps.js";
import { resolveMainSessionKeyFromConfig } from "../../config/sessions.js";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  normalizeHookDispatchSessionKey,
  type HookAgentDispatchPayload,
  type HooksConfigResolved,
} from "../hooks.js";
import { dispatchAgentIngressAction, dispatchWakeIngressAction } from "../ingress-dispatch.js";
import { createHooksRequestHandler } from "../server-http.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

export function createGatewayHooksRequestHandler(params: {
  deps: CliDeps;
  getHooksConfig: () => HooksConfigResolved | null;
  bindHost: string;
  port: number;
  logHooks: SubsystemLogger;
}) {
  const { deps, getHooksConfig, bindHost, port, logHooks } = params;

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
    dispatchAgentHook,
    dispatchWakeHook,
  });
}
