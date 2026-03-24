import { execAsync } from "../../../shared/exec.js";
import { log } from "../../../logging/log.js";

/**
 * Self-healing Doctor Heartbeat.
 * Periodically runs a focused subset of 'openclaw doctor' checks.
 * Attempts to auto-repair minor configuration or environment drifts.
 */
export class DoctorHeartbeat {
    private interval: NodeJS.Timeout | null = null;

    start(intervalMs: number = 14400000) { // Every 4 hours
        console.info("[janitor] Starting self-healing doctor heartbeat...");
        this.interval = setInterval(() => void this.runDiagnostics(), intervalMs);
    }

    async runDiagnostics() {
        log.info("[janitor] Running periodic environment diagnostics...");
        try {
            // Run doctor with auto-repair enabled
            const { stdout } = await execAsync("openclaw doctor --repair --yes");
            log.info("[janitor] Diagnostics complete. Summary: " + stdout.slice(0, 200).replace(/\n/g, " "));
        } catch (e) {
            log.error("[janitor] Background doctor repair failed:", e);
        }
    }

    stop() {
        if (this.interval) clearInterval(this.interval);
    }
}
