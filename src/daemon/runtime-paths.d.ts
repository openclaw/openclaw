import { resolveStableNodePath } from "../infra/stable-node-path.js";
type ExecFileAsync = (file: string, args: readonly string[], options: {
    encoding: "utf8";
}) => Promise<{
    stdout: string;
    stderr: string;
}>;
export type SystemNodeInfo = {
    path: string;
    version: string | null;
    supported: boolean;
};
export declare function isVersionManagedNodePath(nodePath: string, platform?: NodeJS.Platform): boolean;
export declare function isSystemNodePath(nodePath: string, env?: Record<string, string | undefined>, platform?: NodeJS.Platform): boolean;
export declare function resolveSystemNodePath(env?: Record<string, string | undefined>, platform?: NodeJS.Platform): Promise<string | null>;
export declare function resolveSystemNodeInfo(params: {
    env?: Record<string, string | undefined>;
    platform?: NodeJS.Platform;
    execFile?: ExecFileAsync;
}): Promise<SystemNodeInfo | null>;
export declare function renderSystemNodeWarning(systemNode: SystemNodeInfo | null, selectedNodePath?: string): string | null;
export { resolveStableNodePath };
export declare function resolvePreferredNodePath(params: {
    env?: Record<string, string | undefined>;
    runtime?: string;
    platform?: NodeJS.Platform;
    execFile?: ExecFileAsync;
    execPath?: string;
}): Promise<string | undefined>;
