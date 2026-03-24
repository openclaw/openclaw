import fs from "node:fs/promises";
import path from "node:path";

/**
 * Recursively scans directories for OpenClaw skill manifests.
 * Enables deep organization of skills into nested project folders.
 */
export async function findSkillsRecursively(rootPath: string): Promise<string[]> {
    const manifests: string[] = [];
    
    async function scan(dir: string) {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory() && entry.name !== "node_modules") {
                await scan(fullPath);
            } else if (entry.isFile() && entry.name === "skill.json") {
                manifests.push(fullPath);
            }
        }
    }

    await scan(rootPath);
    return manifests;
}
