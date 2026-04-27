import { type SkillCommandSpec } from "../agents/skills.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
export { listReservedChatSlashCommandNames, resolveSkillCommandInvocation, } from "./skill-commands-base.js";
export declare function listSkillCommandsForWorkspace(params: {
    workspaceDir: string;
    cfg: OpenClawConfig;
    agentId?: string;
    skillFilter?: string[];
}): SkillCommandSpec[];
declare function dedupeBySkillName(commands: SkillCommandSpec[]): SkillCommandSpec[];
export declare function listSkillCommandsForAgents(params: {
    cfg: OpenClawConfig;
    agentIds?: string[];
}): SkillCommandSpec[];
export declare const __testing: {
    dedupeBySkillName: typeof dedupeBySkillName;
};
