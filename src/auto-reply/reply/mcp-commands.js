import { parseStandardSetUnsetSlashCommand } from "./commands-setunset-standard.js";
export function parseMcpCommand(raw) {
    return parseStandardSetUnsetSlashCommand({
        raw,
        slash: "/mcp",
        invalidMessage: "Invalid /mcp syntax.",
        usageMessage: "Usage: /mcp show|set|unset",
        onKnownAction: (action, args) => {
            if (action === "show" || action === "get") {
                return { action: "show", name: args || undefined };
            }
            return undefined;
        },
        onSet: (name, value) => ({ action: "set", name, value }),
        onUnset: (name) => ({ action: "unset", name }),
    });
}
