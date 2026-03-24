import { execAsync } from "../../shared/exec.js";
import fs from "fs";

/**
 * Self-healing janitor for the memory search index.
 * Detects empty or corrupted indexes and triggers a force re-index.
 * Addresses #53955.
 */
export async function repairMemoryIndex(indexDir: string) {
    const sqlitePath = `${indexDir}/index.sqlite`;
    if (fs.existsSync(sqlitePath)) {
        const stats = fs.statSync(sqlitePath);
        // If file is too small, it's likely an empty/broken index from a failed update
        if (stats.size < 4096) {
            console.warn("[memory-janitor] Detected corrupted or empty search index. Triggering repair...");
            try {
                await execAsync("openclaw memory index --force");
                console.info("[memory-janitor] Search index repaired successfully.");
            } catch (e) {
                console.error("[memory-janitor] Failed to repair search index.");
            }
        }
    }
}
