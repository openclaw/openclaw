import { type LocalCommandProbe } from "./probes.js";
export type CrestodianAgentSummary = {
    id: string;
    name?: string;
    isDefault: boolean;
    model?: string;
    workspace?: string;
};
export type CrestodianOverview = {
    config: {
        path: string;
        exists: boolean;
        valid: boolean;
        issues: string[];
        hash: string | null;
    };
    agents: CrestodianAgentSummary[];
    defaultAgentId: string;
    defaultModel?: string;
    tools: {
        codex: LocalCommandProbe;
        claude: LocalCommandProbe;
        apiKeys: {
            openai: boolean;
            anthropic: boolean;
        };
    };
    gateway: {
        url: string;
        source: string;
        reachable: boolean;
        error?: string;
    };
    references: {
        docsPath?: string;
        docsUrl: string;
        sourcePath?: string;
        sourceUrl: string;
    };
};
export declare function loadCrestodianOverview(opts?: {
    env?: NodeJS.ProcessEnv;
}): Promise<CrestodianOverview>;
export declare function formatCrestodianOverview(overview: CrestodianOverview): string;
export declare function recommendCrestodianNextStep(overview: CrestodianOverview): string;
export declare function formatCrestodianStartupMessage(overview: CrestodianOverview): string;
