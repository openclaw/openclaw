// Shared gateway CLI helpers for supervised-service stop guidance.
import {
  resolveGatewayLaunchAgentLabel,
  resolveGatewaySystemdServiceName,
  resolveGatewayWindowsTaskName,
} from "../../daemon/constants.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { defaultRuntime } from "../../runtime.js";
import { formatCliCommand } from "../command-format.js";

function renderGatewayServiceStopHints(env: NodeJS.ProcessEnv = process.env): string[] {
  const profile = env.OPENCLAW_PROFILE;
  const hints = [`Tip: ${formatCliCommand("openclaw gateway stop")}`];
  switch (process.platform) {
    case "darwin":
      hints.push(`Or: launchctl bootout gui/$UID/${resolveGatewayLaunchAgentLabel(profile)}`);
      break;
    case "linux":
      hints.push(`Or: systemctl --user stop ${resolveGatewaySystemdServiceName(profile)}.service`);
      break;
    case "win32":
      hints.push(`Or: schtasks /End /TN "${resolveGatewayWindowsTaskName(profile)}"`);
      break;
    default:
      break;
  }
  return hints;
}

export async function maybeExplainGatewayServiceStop() {
  // Direct `gateway run` should not race a managed service on the same port.
  const service = resolveGatewayService();
  let loaded: boolean | null;
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
