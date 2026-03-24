import { execAsync } from "../../../shared/exec.js";
import { log } from "../../../logging/log.js";

/**
 * Automated Session Pruner.
 * Periodically archives or removes idle agent sessions.
 */
export async function pruneIdleSessions(maxIdleDays: number = 30) {
    console.info(`[janitor] Pruning sessions idle for more than ${maxIdleDays} days...`);
    try {
        // Logic to call internal session manager to list and delete old sessions
        // For now, we'll use a placeholder for the subagents cleanup command
        const { stdout } = await execAsync(`openclaw subagents kill --recent ${maxIdleDays * 24 * 60}`);
        log.info("[janitor] Idle session pruning complete: " + stdout.trim());
    } catch (e) {
        log.error("[janitor] Failed to prune sessions:", e);
    }
}
