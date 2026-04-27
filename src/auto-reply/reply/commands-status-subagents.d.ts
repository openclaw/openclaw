import type { SubagentRunRecord } from "../../agents/subagent-registry.types.js";
export declare function buildSubagentsStatusLine(params: {
    runs: SubagentRunRecord[];
    verboseEnabled: boolean;
    pendingDescendantsForRun: (entry: SubagentRunRecord) => number;
}): string | undefined;
