import { assertNoSystemLaunchDaemonOwnership } from "../../daemon/launchd-system.js";
// macOS LaunchAgent recovery helper for daemon lifecycle commands.
import {
  formatLaunchAgentGuiSessionError,
  launchAgentPlistExists,
  repairLaunchAgentBootstrap,
  resolveLaunchAgentLabel,
} from "../../daemon/launchd.js";
import type { GatewayServiceControlArgs } from "../../daemon/service-types.js";

const LAUNCH_AGENT_RECOVERY_MESSAGE =
  "Gateway LaunchAgent was installed but not loaded; re-bootstrapped launchd service.";

/** Re-bootstrap an installed but unloaded LaunchAgent after a daemon start/restart command. */
export async function recoverInstalledLaunchAgent<TResult extends "started" | "restarted">(params: {
  result: TResult;
  deadline?: GatewayServiceControlArgs["deadline"];
  env?: Record<string, string | undefined>;
}): Promise<{
  result: TResult;
  loaded: true;
  message: string;
} | null> {
  if (process.platform !== "darwin") {
    return null;
  }
  const env = params.env ?? process.env;
  // Check host-wide ownership even when no user plist exists. Otherwise start
  // and restart would report "not installed" for a gateway already supervised
  // by a same-label system LaunchDaemon.
  await assertNoSystemLaunchDaemonOwnership(resolveLaunchAgentLabel(env));
  const plistExists = await launchAgentPlistExists(env).catch(() => false);
  if (!plistExists) {
    return null;
  }
  const repaired = await repairLaunchAgentBootstrap({ env, deadline: params.deadline }).catch(
    () => ({
      ok: false as const,
      status: "bootstrap-failed" as const,
    }),
  );
  if (!repaired.ok) {
    if (
      repaired.status === "system-launchdaemon-conflict" ||
      repaired.status === "system-launchdaemon-unverifiable"
    ) {
      throw new Error(repaired.detail);
    }
    if (repaired.status === "gui-session-unavailable") {
      const actionHint =
        params.result === "started" ? "openclaw gateway start" : "openclaw gateway restart";
      throw new Error(
        formatLaunchAgentGuiSessionError({
          detail: repaired.detail,
          domain: repaired.domain,
          actionHint,
        }),
      );
    }
    return null;
  }
  return {
    result: params.result,
    loaded: true,
    message: LAUNCH_AGENT_RECOVERY_MESSAGE,
  };
}
