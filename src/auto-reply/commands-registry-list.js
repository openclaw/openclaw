import { isCommandFlagEnabled } from "../config/commands.flags.js";
import { getChatCommands } from "./commands-registry.data.js";
function buildSkillCommandDefinitions(skillCommands) {
    if (!skillCommands || skillCommands.length === 0) {
        return [];
    }
    return skillCommands.map((spec) => ({
        key: `skill:${spec.skillName}`,
        nativeName: spec.name,
        description: spec.description,
        textAliases: [`/${spec.name}`],
        acceptsArgs: true,
        argsParsing: "none",
        scope: "both",
        category: "tools",
    }));
}
export function listChatCommands(params) {
    const commands = getChatCommands();
    if (!params?.skillCommands?.length) {
        return [...commands];
    }
    return [...commands, ...buildSkillCommandDefinitions(params.skillCommands)];
}
export function isCommandEnabled(cfg, commandKey) {
    if (commandKey === "config") {
        return isCommandFlagEnabled(cfg, "config");
    }
    if (commandKey === "mcp") {
        return isCommandFlagEnabled(cfg, "mcp");
    }
    if (commandKey === "plugins") {
        return isCommandFlagEnabled(cfg, "plugins");
    }
    if (commandKey === "debug") {
        return isCommandFlagEnabled(cfg, "debug");
    }
    if (commandKey === "bash") {
        return isCommandFlagEnabled(cfg, "bash");
    }
    return true;
}
export function listChatCommandsForConfig(cfg, params) {
    const base = getChatCommands().filter((command) => isCommandEnabled(cfg, command.key));
    if (!params?.skillCommands?.length) {
        return base;
    }
    return [...base, ...buildSkillCommandDefinitions(params.skillCommands)];
}
