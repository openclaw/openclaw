import { saveJsonFile, loadJsonFile } from "../../json-file.js";
import path from "node:path";

/**
 * Skill Manifest Cache.
 * Caches parsed skill metadata to reduce filesystem load during discovery.
 * Addresses performance bottlenecks in large skill registries.
 */
export class SkillManifestCache {
    private cachePath: string;

    constructor(workspaceDir: string) {
        this.cachePath = path.join(workspaceDir, "cache", "skill-manifests.json");
    }

    saveCache(data: Record<string, any>) {
        saveJsonFile(this.cachePath, {
            timestamp: Date.now(),
            manifests: data
        });
    }

    loadCache() {
        const cached: any = loadJsonFile(this.cachePath);
        // Valid for 1 hour by default
        if (cached && (Date.now() - cached.timestamp < 3600000)) {
            return cached.manifests;
        }
        return null;
    }
}
