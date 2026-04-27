import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { type MemoryReadResult } from "./read-file-shared.js";
export declare function readMemoryFile(params: {
    workspaceDir: string;
    extraPaths?: string[];
    relPath: string;
    from?: number;
    lines?: number;
    defaultLines?: number;
    maxChars?: number;
}): Promise<MemoryReadResult>;
export declare function readAgentMemoryFile(params: {
    cfg: OpenClawConfig;
    agentId: string;
    relPath: string;
    from?: number;
    lines?: number;
}): Promise<MemoryReadResult>;
