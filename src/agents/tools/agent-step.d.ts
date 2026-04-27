import { callGateway } from "../../gateway/call.js";
export { readLatestAssistantReply } from "../run-wait.js";
type GatewayCaller = typeof callGateway;
export declare function runAgentStep(params: {
    sessionKey: string;
    message: string;
    extraSystemPrompt: string;
    timeoutMs: number;
    channel?: string;
    lane?: string;
    sourceSessionKey?: string;
    sourceChannel?: string;
    sourceTool?: string;
}): Promise<string | undefined>;
export declare const __testing: {
    setDepsForTest(overrides?: Partial<{
        callGateway: GatewayCaller;
    }>): void;
};
