import fs from "node:fs";
import path from "node:path";
import { resolveConfigDir } from "../utils.js";

const PATCH_MANIFEST_FILE = "patch_manifest.json";

export interface PatchRecord {
    id: string; // usually filename
    description: string;
    appliedAt: number;
    filesAffected: string[];
}

export interface PatchManifest {
    patches: PatchRecord[];
    lastUpdated: number;
}

export class PatchManager {
    private manifestPath: string;

    constructor() {
        const configDir = resolveConfigDir();
        this.manifestPath = path.join(configDir, PATCH_MANIFEST_FILE);
    }

    private load(): PatchManifest {
        if (!fs.existsSync(this.manifestPath)) {
            return { patches: [], lastUpdated: Date.now() };
        }
        try {
            return JSON.parse(fs.readFileSync(this.manifestPath, "utf-8"));
        } catch (e) {
            console.warn("Failed to load patch manifest, resetting.", e);
            return { patches: [], lastUpdated: Date.now() };
        }
    }

    private save(data: PatchManifest) {
        try {
            data.lastUpdated = Date.now();
            fs.writeFileSync(this.manifestPath, JSON.stringify(data, null, 2));
        } catch (e) {
            console.error("Failed to save patch manifest:", e);
        }
    }

    public registerPatch(filename: string, description: string, filesAffected: string[] = []) {
        const data = this.load();

        // Remove existing record if overwriting
        const existingIndex = data.patches.findIndex(p => p.id === filename);
        if (existingIndex !== -1) {
            data.patches.splice(existingIndex, 1);
        }

        data.patches.push({
            id: filename,
            description,
            appliedAt: Date.now(),
            filesAffected
        });

        this.save(data);
        console.log(`[PatchManager] Recorded patch in manifest: ${filename}`);
    }

    public getAppliedPatches(): PatchRecord[] {
        return this.load().patches;
    }
}

export const patchManager = new PatchManager();
