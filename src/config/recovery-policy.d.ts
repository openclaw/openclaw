import type { ConfigFileSnapshot } from "./types.openclaw.js";
/**
 * Returns true when an invalid config snapshot is scoped entirely to plugin entries.
 */
export declare function isPluginLocalInvalidConfigSnapshot(snapshot: Pick<ConfigFileSnapshot, "valid" | "issues" | "legacyIssues">): boolean;
/**
 * Decides whether whole-file last-known-good recovery is safe for a snapshot.
 */
export declare function shouldAttemptLastKnownGoodRecovery(snapshot: Pick<ConfigFileSnapshot, "valid" | "issues" | "legacyIssues">): boolean;
