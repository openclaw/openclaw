import { type RuntimeEnv } from "../runtime.js";
type AgentsAddOptions = {
    name?: string;
    workspace?: string;
    model?: string;
    agentDir?: string;
    bind?: string[];
    nonInteractive?: boolean;
    json?: boolean;
};
export declare function agentsAddCommand(opts: AgentsAddOptions, runtime?: RuntimeEnv, params?: {
    hasFlags?: boolean;
}): Promise<void>;
export {};
