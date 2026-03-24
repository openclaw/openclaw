/**
 * Normalizes plugin ID hints to prevent false-positive mismatch warnings.
 * Prioritizes the manifest ID over npm package basenames (#53954).
 */
export function getPluginIdHint(manifestId: string, entryKey: string): string {
    // If the entry key contains the manifest ID or vice versa, they are considered aligned.
    if (entryKey.includes(manifestId) || manifestId.includes(entryKey)) {
        return manifestId;
    }
    return entryKey;
}
