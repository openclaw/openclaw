export type BuildManager = "pnpm" | "bun" | "npm";
export type UpdatePackageManagerRequirement = "allow-fallback" | "require-preferred";
export type UpdatePackageManagerFailureReason = "preferred-manager-unavailable" | "pnpm-corepack-enable-failed" | "pnpm-corepack-missing" | "pnpm-npm-bootstrap-failed";
export type PackageManagerCommandRunner = (argv: string[], options: {
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
}) => Promise<{
    stdout: string;
    stderr: string;
    code: number | null;
}>;
export type ResolvedBuildManager = {
    kind: "resolved";
    manager: BuildManager;
    preferred: BuildManager;
    fallback: boolean;
    env?: NodeJS.ProcessEnv;
    cleanup?: () => Promise<void>;
} | {
    kind: "missing-required";
    preferred: BuildManager;
    reason: UpdatePackageManagerFailureReason;
};
export declare function detectBuildManager(root: string): Promise<BuildManager>;
export declare function resolveUpdateBuildManager(runCommand: PackageManagerCommandRunner, root: string, timeoutMs: number, baseEnv?: NodeJS.ProcessEnv, requirement?: UpdatePackageManagerRequirement): Promise<ResolvedBuildManager>;
export declare function managerScriptArgs(manager: BuildManager, script: string, args?: string[]): string[];
export declare function managerInstallArgs(manager: BuildManager, opts?: {
    compatFallback?: boolean;
}): string[];
export declare function managerInstallIgnoreScriptsArgs(manager: BuildManager): string[] | null;
