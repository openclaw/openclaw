import { parseStandardSetUnsetSlashCommand } from "./commands-setunset-standard.js";
export function parseConfigCommand(raw) {
    return parseStandardSetUnsetSlashCommand({
        raw,
        slash: "/config",
        invalidMessage: "Invalid /config syntax.",
        usageMessage: "Usage: /config show|set|unset",
        onKnownAction: (action, args) => {
            if (action === "show" || action === "get") {
                return { action: "show", path: args || undefined };
            }
            return undefined;
        },
    });
}
