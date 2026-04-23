import { launchAgentPlistExists, repairLaunchAgentBootstrap } from "../../daemon/launchd.js";

const LAUNCH_AGENT_RECOVERY_MESSAGE =
  "Gateway LaunchAgent was installed but not loaded; re-bootstrapped launchd service.";

type LaunchAgentRecoveryAction = "started" | "restarted";

type LaunchAgentRecoveryResult = {
  result: LaunchAgentRecoveryAction;
  loaded: true;
  message: string;
};

export async function recoverInstalledLaunchAgent(params: {
  result: LaunchAgentRecoveryAction;
  env?: Record<string, string | undefined>;
}): Promise<LaunchAgentRecoveryResult | null> {
  if (process.platform !== "darwin") {
    return null;
  }
  const env = params.env ?? (process.env as Record<string, string | undefined>);
  const plistExists = await launchAgentPlistExists(env).catch(() => false);
  if (!plistExists) {
    return null;
  }
  const repaired = await repairLaunchAgentBootstrap({ env }).catch(() => ({
    ok: false as const,
    status: "bootstrap-failed" as const,
  }));
  if (!repaired.ok) {
    return null;
  }
  return {
    result: params.result,
    loaded: true,
    message: LAUNCH_AGENT_RECOVERY_MESSAGE,
  };
}

export { LAUNCH_AGENT_RECOVERY_MESSAGE };
