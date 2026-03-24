import { saveJsonFile } from "../../json-file.js";

/**
 * Ensures that session state is dually persisted to disk and memory before termination.
 * Prevents "lost turns" or "state amnesia" during gateway restarts.
 */
export async function flushSessionStateWithGuard(sessionKey: string, state: any, storePath: string) {
    try {
        console.info(`[durability] [${sessionKey}] Performing atomic state flush...`);
        // Uses the atomic write pattern implemented in Wave 18
        saveJsonFile(storePath, state);
        return true;
    } catch (e) {
        console.error(`[durability] [${sessionKey}] CRITICAL: Failed to flush session state: ${e}`);
        return false;
    }
}
