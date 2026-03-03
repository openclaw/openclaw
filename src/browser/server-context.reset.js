import fs from "node:fs";
import { stopChromeExtensionRelayServer } from "./extension-relay.js";
import { movePathToTrash } from "./trash.js";
async function closePlaywrightBrowserConnection() {
    try {
        const mod = await import("./pw-ai.js");
        await mod.closePlaywrightBrowserConnection();
    }
    catch {
        // ignore
    }
}
export function createProfileResetOps({ profile, getProfileState, stopRunningBrowser, isHttpReachable, resolveOpenClawUserDataDir, }) {
    const resetProfile = async () => {
        if (profile.driver === "extension") {
            await stopChromeExtensionRelayServer({ cdpUrl: profile.cdpUrl }).catch(() => { });
            return { moved: false, from: profile.cdpUrl };
        }
        if (!profile.cdpIsLoopback) {
            throw new Error(`reset-profile is only supported for local profiles (profile "${profile.name}" is remote).`);
        }
        const userDataDir = resolveOpenClawUserDataDir(profile.name);
        const profileState = getProfileState();
        const httpReachable = await isHttpReachable(300);
        if (httpReachable && !profileState.running) {
            // Port in use but not by us - kill it.
            await closePlaywrightBrowserConnection();
        }
        if (profileState.running) {
            await stopRunningBrowser();
        }
        await closePlaywrightBrowserConnection();
        if (!fs.existsSync(userDataDir)) {
            return { moved: false, from: userDataDir };
        }
        const moved = await movePathToTrash(userDataDir);
        return { moved: true, from: userDataDir, to: moved };
    };
    return { resetProfile };
}
