import { parseStandardSetUnsetSlashCommand } from "./commands-setunset-standard.js";
export function parseDebugCommand(raw) {
    return parseStandardSetUnsetSlashCommand({
        raw,
        slash: "/debug",
        invalidMessage: "Invalid /debug syntax.",
        usageMessage: "Usage: /debug show|set|unset|reset",
        onKnownAction: (action) => {
            if (action === "show") {
                return { action: "show" };
            }
            if (action === "reset") {
                return { action: "reset" };
            }
            return undefined;
        },
    });
}
