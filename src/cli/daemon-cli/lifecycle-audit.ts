import {
  appendGatewayLifecycleAuditLog,
  type GatewayLifecycleAuditSource,
} from "../../daemon/restart-logs.js";
/** Gateway lifecycle audit helpers shared by managed and unmanaged CLI paths. */
import type { GatewayLifecycleMutation } from "../../daemon/service-types.js";
import { isTerminalInteractive } from "../terminal-interactivity.js";

type GatewayLifecycleAction = "start" | "stop" | "restart";

export function appendGatewayLifecycleAudit(params: {
  action: GatewayLifecycleAction;
  source: GatewayLifecycleAuditSource;
  mode: string;
  pid?: number;
  env?: NodeJS.ProcessEnv;
}): void {
  appendGatewayLifecycleAuditLog(params.env ?? process.env, {
    action: params.action,
    source: params.source,
    mode: params.mode,
    ...(params.pid === undefined ? {} : { pid: params.pid }),
    interactive: isTerminalInteractive(),
  });
}

export function createGatewayLifecycleMutationAudit(params: {
  action: GatewayLifecycleAction;
  source?: GatewayLifecycleAuditSource;
  env?: NodeJS.ProcessEnv;
}): (mutation: GatewayLifecycleMutation) => void {
  return (mutation) => {
    appendGatewayLifecycleAudit({
      action: params.action,
      source: params.source ?? "cli",
      mode: mutation.mode,
      ...(mutation.pid === undefined ? {} : { pid: mutation.pid }),
      ...(params.env === undefined ? {} : { env: params.env }),
    });
  };
}
