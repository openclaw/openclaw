import fs from "node:fs/promises";
import path from "node:path";

/**
 * Cleanup Janitor for temporary artifacts.
 * Removes stale .tmp files and orphaned lockfiles during startup.
 */
export async function cleanupStaleArtifacts(rootDirs: string[]) {
    console.info("[janitor] Cleaning up stale temporary artifacts...");
    
    for (const dir of rootDirs) {
        try {
            const files = await fs.readdir(dir);
            for (const file of files) {
                if (file.includes(".tmp-") || file.endsWith(".lock")) {
                    const fullPath = path.join(dir, file);
                    const stats = await fs.stat(fullPath);
                    
                    // If file is older than 1 hour, it's likely orphaned
                    if (Date.now() - stats.mtimeMs > 3600000) {
                        await fs.unlink(fullPath);
                        console.info(`[janitor] Removed stale artifact: ${file}`);
                    }
                }
            }
        } catch (e) {
            // Directory likely doesn't exist or is inaccessible
        }
    }
}
