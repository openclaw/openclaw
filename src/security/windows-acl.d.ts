import { runExec } from "../process/exec.js";
export type ExecFn = typeof runExec;
export type WindowsAclEntry = {
    principal: string;
    rights: string[];
    rawRights: string;
    canRead: boolean;
    canWrite: boolean;
};
export type WindowsAclSummary = {
    ok: boolean;
    entries: WindowsAclEntry[];
    untrustedWorld: WindowsAclEntry[];
    untrustedGroup: WindowsAclEntry[];
    trusted: WindowsAclEntry[];
    error?: string;
};
export declare function resolveWindowsUserPrincipal(env?: NodeJS.ProcessEnv): string | null;
export declare function parseIcaclsOutput(output: string, targetPath: string): WindowsAclEntry[];
export declare function summarizeWindowsAcl(entries: WindowsAclEntry[], env?: NodeJS.ProcessEnv): Pick<WindowsAclSummary, "trusted" | "untrustedWorld" | "untrustedGroup">;
export declare function inspectWindowsAcl(targetPath: string, opts?: {
    env?: NodeJS.ProcessEnv;
    exec?: ExecFn;
}): Promise<WindowsAclSummary>;
export declare function formatWindowsAclSummary(summary: WindowsAclSummary): string;
export declare function formatIcaclsResetCommand(targetPath: string, opts: {
    isDir: boolean;
    env?: NodeJS.ProcessEnv;
}): string;
export declare function createIcaclsResetCommand(targetPath: string, opts: {
    isDir: boolean;
    env?: NodeJS.ProcessEnv;
}): {
    command: string;
    args: string[];
    display: string;
} | null;
