import { type RuntimeEnv } from "../runtime.js";
export declare function resolveControlUiDistIndexPathForRoot(root: string): string;
export type ControlUiDistIndexHealth = {
    indexPath: string | null;
    exists: boolean;
};
export declare function resolveControlUiDistIndexHealth(opts?: {
    root?: string;
    argv1?: string;
    moduleUrl?: string;
}): Promise<ControlUiDistIndexHealth>;
export declare function resolveControlUiRepoRoot(argv1?: string | undefined): string | null;
export declare function resolveControlUiDistIndexPath(argv1OrOpts?: string | {
    argv1?: string;
    moduleUrl?: string;
}): Promise<string | null>;
export type ControlUiRootResolveOptions = {
    argv1?: string;
    moduleUrl?: string;
    cwd?: string;
    execPath?: string;
};
export declare function resolveControlUiRootOverrideSync(rootOverride: string): string | null;
export declare function resolveControlUiRootSync(opts?: ControlUiRootResolveOptions): string | null;
export declare function isPackageProvenControlUiRootSync(root: string, opts?: ControlUiRootResolveOptions): boolean;
export type EnsureControlUiAssetsResult = {
    ok: boolean;
    built: boolean;
    message?: string;
};
export declare function ensureControlUiAssetsBuilt(runtime?: RuntimeEnv, opts?: {
    timeoutMs?: number;
}): Promise<EnsureControlUiAssetsResult>;
