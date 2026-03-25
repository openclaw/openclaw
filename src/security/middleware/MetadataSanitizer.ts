/**
 * Critical Security: Inbound Metadata Sanitizer.
 * Fixes #54737: Prevents Prompt Injection via unsanitized group chat names and user metadata.
 * Ensures system message integrity for Sovereign Agent operations.
 */
export class MetadataSanitizer {
    static sanitize(raw: string): string {
        return raw.replace(/\[System Message\]/gi, "[Filtered]")
                  .replace(/---/g, "-")
                  .substring(0, 256);
    }
}
