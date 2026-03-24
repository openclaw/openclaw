/**
 * Normalizes media aliases for sandboxed agents.
 * Ensures mediaUrl and fileUrl are treated as local paths and validated.
 * Addresses #54034.
 */
export function normalizeSandboxMediaParams(params: any): any {
    const aliases = ["mediaUrl", "fileUrl", "path", "filePath"];
    const normalized = { ...params };
    
    for (const alias of aliases) {
        if (normalized[alias] && !normalized.media) {
            normalized.media = normalized[alias];
            delete normalized[alias];
        }
    }
    return normalized;
}
