import { execAsync } from "../../shared/exec.js";
import { log } from "../../logging/log.js";

/**
 * Background watcher for OpenClaw updates.
 * Periodically checks the configured channel (git or npm) for new releases.
 */
export class UpdateWatcher {
    private interval: NodeJS.Timeout | null = null;

    start(intervalMs: number = 3600000) { // Default: 1 hour
        console.info("[updates] Starting background update watcher...");
        this.interval = setInterval(() => void this.checkForUpdates(), intervalMs);
    }

    async checkForUpdates() {
        try {
            // Logic to call 'openclaw update status --json' via internal RPC or exec
            const { stdout } = await execAsync("openclaw update status --json");
            const status = JSON.parse(stdout);
            
            if (status.updateAvailable) {
                log.info(`[updates] A new OpenClaw version (${status.latestVersion}) is available on the ${status.channel} channel.`);
                // Logic to emit a system event for user notification
            }
        } catch (e) {
            log.error("[updates] Failed to check for updates:", e);
        }
    }

    stop() {
        if (this.interval) clearInterval(this.interval);
    }
}
