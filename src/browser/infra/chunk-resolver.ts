import fs from "node:fs";
import path from "node:path";

/**
 * Resolves Playwright AI chunks by searching for existing files on disk.
 * Fixes the hash mismatch issue in Atomic Bot Electron builds.
 * Addresses #54023.
 */
export function resolvePlaywrightChunk(distDir: string, baseName: string): string | null {
    const files = fs.readdirSync(distDir);
    // Find files matching the base pattern (e.g., pw-ai-*)
    const match = files.find(f => f.startsWith(baseName) && f.endsWith(".js"));
    
    if (match) {
        console.info(`[browser] Resolved chunk ${baseName} to: ${match}`);
        return path.join(distDir, match);
    }
    
    return null;
}
