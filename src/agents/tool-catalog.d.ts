export type ToolProfileId = "minimal" | "coding" | "messaging" | "full";
type ToolProfilePolicy = {
    allow?: string[];
    deny?: string[];
};
export type CoreToolSection = {
    id: string;
    label: string;
    tools: Array<{
        id: string;
        label: string;
        description: string;
    }>;
};
export declare const CORE_TOOL_GROUPS: {
    "group:openclaw": string[];
};
export declare const PROFILE_OPTIONS: readonly [{
    readonly id: "minimal";
    readonly label: "Minimal";
}, {
    readonly id: "coding";
    readonly label: "Coding";
}, {
    readonly id: "messaging";
    readonly label: "Messaging";
}, {
    readonly id: "full";
    readonly label: "Full";
}];
export declare function resolveCoreToolProfilePolicy(profile?: string): ToolProfilePolicy | undefined;
export declare function listCoreToolSections(): CoreToolSection[];
export declare function resolveCoreToolProfiles(toolId: string): ToolProfileId[];
export declare function isKnownCoreToolId(toolId: string): boolean;
export {};
