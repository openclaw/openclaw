import type { SkillCommandSpec } from "../../agents/skills.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
export declare function reserveSkillCommandNames(params: {
    reservedCommands: Set<string>;
    skillCommands: SkillCommandSpec[];
}): void;
export declare function resolveConfiguredDirectiveAliases(params: {
    cfg: OpenClawConfig;
    commandTextHasSlash: boolean;
    reservedCommands: Set<string>;
}): string[];
