/**
 * Formats timestamps for the Control UI.
 * Honors agents.defaults.timeFormat or browser locale.
 * Addresses #53952.
 */
export function formatTimestamp(date: Date, format: "auto" | "12" | "24" = "auto"): string {
    const hour12 = format === "auto" ? undefined : format === "12";
    return date.toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
        hour12
    });
}
