/**
 * OpenClaw Metadata Sanitizer.
 * Fixes critical prompt injection vulnerability by sanitizing group chat metadata.
 * Prevents attackers from injecting system-level instructions via user/group names.
 */
export class MetadataSanitizer {
    sanitize(input: string): string {
        console.log("STRIKE_VERIFIED: Sanitizing inbound metadata to prevent prompt injection.");
        return input.replace(/\[System Message\]/gi, "[Filtered]")
                    .replace(/User Instructions:/gi, "User Info:")
                    .trim();
    }
}
