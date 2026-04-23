import {
  resolveGatewayLaunchAgentLabel,
  resolveGatewaySystemdServiceName,
  resolveGatewayWindowsTaskName,
} from "../../daemon/constants.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { defaultRuntime } from "../../runtime.js";
import { formatCliCommand } from "../command-format.js";
import { parsePort } from "../shared/parse-port.js";

export { parsePort };

export const toOptionString = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return value.toString();
  }
  return undefined;
};

export function extractGatewayMiskeys(parsed: unknown): {
  hasGatewayToken: boolean;
  hasRemoteToken: boolean;
} {
  if (!parsed || typeof parsed !== "object") {
    return { hasGatewayToken: false, hasRemoteToken: false };
  }
  const gateway = (parsed as Record<string, unknown>).gateway;
  if (!gateway || typeof gateway !== "object") {
    return { hasGatewayToken: false, hasRemoteToken: false };
  }
  const hasGatewayToken = "token" in (gateway as Record<string, unknown>);
  const remote = (gateway as Record<string, unknown>).remote;
  const hasRemoteToken =
    remote && typeof remote === "object" ? "token" in (remote as Record<string, unknown>) : false;
  return { hasGatewayToken, hasRemoteToken };
}

export function renderGatewayServiceStopHints(env: NodeJS.ProcessEnv = process.env): string[] {
  const profile = env.OPENCLAW_PROFILE;
  switch (process.platform) {
    case "darwin":
      return [
        `Tip: ${formatCliCommand("openclaw gateway stop")}`,
        `Or: launchctl bootout gui/$UID/${resolveGatewayLaunchAgentLabel(profile)}`,
      ];
    case "linux":
      return [
        `Tip: ${formatCliCommand("openclaw gateway stop")}`,
        `Or: systemctl --user stop ${resolveGatewaySystemdServiceName(profile)}.service`,
      ];
    case "win32":
      return [
        `Tip: ${formatCliCommand("openclaw gateway stop")}`,
        `Or: schtasks /End /TN "${resolveGatewayWindowsTaskName(profile)}"`,
      ];
    default:
      return [`Tip: ${formatCliCommand("openclaw gateway stop")}`];
  }
}

export async function maybeExplainGatewayServiceStop() {
  const service = resolveGatewayService();
  let loaded: boolean | null = null;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch {
    loaded = null;
  }
  if (loaded === false) {
    return;
  }
  defaultRuntime.error(
    loaded
      ? `Gateway service appears ${service.loadedText}. Stop it first.`
      : "Gateway service status unknown; if supervised, stop it first.",
  );
  for (const hint of renderGatewayServiceStopHints()) {
    defaultRuntime.error(hint);
  }
}
