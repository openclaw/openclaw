import { type ToolProfileId } from "./tool-catalog.js";
type ToolProfilePolicy = {
    allow?: string[];
    deny?: string[];
};
export declare const TOOL_GROUPS: Record<string, string[]>;
export declare function normalizeToolName(name: string): string;
export declare function normalizeToolList(list?: string[]): string[];
export declare function expandToolGroups(list?: string[]): string[];
export declare function resolveToolProfilePolicy(profile?: string): ToolProfilePolicy | undefined;
export type { ToolProfileId };
