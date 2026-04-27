import type { SkillCommandSpec } from "../agents/skills.js";
export declare function listReservedChatSlashCommandNames(extraNames?: string[]): Set<string>;
export declare function resolveSkillCommandInvocation(params: {
    commandBodyNormalized: string;
    skillCommands: SkillCommandSpec[];
}): {
    command: SkillCommandSpec;
    args?: string;
} | null;
