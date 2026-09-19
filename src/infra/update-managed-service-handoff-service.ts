import { resolveGatewayWindowsTaskName } from "../daemon/constants.js";
import { resolveLaunchAgentLabel } from "../daemon/launchd-label.js";
import { resolveLaunchAgentPlistPath } from "../daemon/launchd-service-files.js";
import { resolveSystemdServiceName } from "../daemon/systemd-service-files.js";
import type { RespawnSupervisor } from "./supervisor-markers.js";

type GatewayServiceRecovery =
  | { kind: "systemd"; unit: string }
  | { kind: "launchd"; uid: number; label: string; plistPath: string }
  | { kind: "schtasks"; taskName: string };

export function resolveGatewayServiceRecovery(
  supervisor: RespawnSupervisor | null | undefined,
  env: NodeJS.ProcessEnv,
): GatewayServiceRecovery | undefined {
  if (supervisor === "systemd") {
    return { kind: "systemd", unit: `${resolveSystemdServiceName(env)}.service` };
  }
  if (supervisor === "launchd") {
    const label = resolveLaunchAgentLabel(env);
    const uid = typeof process.getuid === "function" ? process.getuid() : 501;
    return { kind: "launchd", uid, label, plistPath: resolveLaunchAgentPlistPath(env) };
  }
  if (supervisor === "schtasks") {
    const taskName =
      env.OPENCLAW_WINDOWS_TASK_NAME?.trim() || resolveGatewayWindowsTaskName(env.OPENCLAW_PROFILE);
    return { kind: "schtasks", taskName };
  }
  return undefined;
}
