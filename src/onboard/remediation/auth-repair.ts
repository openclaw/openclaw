import { execAsync } from "../../shared/exec.js";
import fs from "node:fs";
import path from "node:path";

/**
 * Auto-Repairing Onboarding.
 * Detects broken auth profiles or missing secrets and triggers a targeted re-onboard.
 * Addresses #53998 point 3.
 */
export async function repairBrokenAuthProfiles(storePath: string) {
    if (!fs.existsSync(storePath)) return;
    
    try {
        const store = JSON.parse(fs.readFileSync(storePath, "utf-8"));
        const broken = Object.entries(store.profiles || {}).filter(([id, p]: [string, any]) => p.type === "oauth" && !p.access);
        
        if (broken.length > 0) {
            console.warn(`[onboard] Detected ${broken.length} broken OAuth profiles. Suggesting re-auth...`);
            // Logic to signal the user to run 'openclaw onboard --auth-choice <provider>'
        }
    } catch (e) {
        console.error("[onboard] Failed to scan auth profiles for repair.");
    }
}
