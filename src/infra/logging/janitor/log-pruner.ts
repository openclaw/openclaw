import fs from "node:fs/promises";
import path from "node:path";

/**
 * Automated Log Pruner.
 * Cleans up gateway and subagent log files older than X days.
 */
export async function pruneOldLogs(logsDir: string, maxAgeDays: number = 7) {
    console.info(`[janitor] Pruning logs older than ${maxAgeDays} days in ${logsDir}...`);
    const now = Date.now();
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

    try {
        const files = await fs.readdir(logsDir);
        for (const file of files) {
            if (file.endsWith(".log") || file.endsWith(".jsonl")) {
                const filePath = path.join(logsDir, file);
                const stats = await fs.stat(filePath);
                if (now - stats.mtimeMs > maxAgeMs) {
                    await fs.unlink(filePath);
                    console.info(`[janitor] Pruned old log file: ${file}`);
                }
            }
        }
    } catch (e) {
        console.error("[janitor] Failed to prune logs:", e);
    }
}
