/**
 * Detects if a secret string is an environment variable reference.
 * Prevents flagging safe indirections as PLAINTEXT_FOUND.
 * Addresses #53998.
 */
export function isEnvVarReference(value: string): boolean {
    // Matches  or  format
    return /^$[A-Z0-9_]+$/.test(value) || /^$\{[A-Z0-9_]+\}$/.test(value);
}

export function getSecretSeverity(value: unknown): "plaintext" | "env-ref" | "secret-ref" {
    if (typeof value === "object" && value !== null && ("ref" in value || "secretRef" in value)) {
        return "secret-ref";
    }
    if (typeof value === "string" && isEnvVarReference(value)) {
        return "env-ref";
    }
    return "plaintext";
}
