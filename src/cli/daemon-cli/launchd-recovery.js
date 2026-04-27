import { launchAgentPlistExists, repairLaunchAgentBootstrap } from "../../daemon/launchd.js";
const LAUNCH_AGENT_RECOVERY_MESSAGE = "Gateway LaunchAgent was installed but not loaded; re-bootstrapped launchd service.";
export async function recoverInstalledLaunchAgent(params) {
    if (process.platform !== "darwin") {
        return null;
    }
    const env = params.env ?? process.env;
    const plistExists = await launchAgentPlistExists(env).catch(() => false);
    if (!plistExists) {
        return null;
    }
    const repaired = await repairLaunchAgentBootstrap({ env }).catch(() => ({
        ok: false,
        status: "bootstrap-failed",
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
