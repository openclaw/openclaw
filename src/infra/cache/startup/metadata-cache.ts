import { saveJsonFile, loadJsonFile } from "../../json-file.js";
import path from "node:path";

/**
 * Startup Metadata Cache.
 * Caches heavy plugin and extension metadata to accelerate gateway boot times.
 */
export class StartupCache {
    private cachePath: string;

    constructor(workspaceDir: string) {
        this.cachePath = path.join(workspaceDir, "cache", "startup-metadata.json");
    }

    saveMetadata(data: any) {
        saveJsonFile(this.cachePath, {
            timestamp: Date.now(),
            data
        });
    }

    loadMetadata(maxAgeMs: number = 86400000) { // 24 hours
        const cached: any = loadJsonFile(this.cachePath);
        if (cached && (Date.now() - cached.timestamp < maxAgeMs)) {
            return cached.data;
        }
        return null;
    }
}
