export declare function resolveEffectiveHomeDir(env?: NodeJS.ProcessEnv, homedir?: () => string): string | undefined;
export declare function resolveOsHomeDir(env?: NodeJS.ProcessEnv, homedir?: () => string): string | undefined;
export declare function resolveRequiredHomeDir(env?: NodeJS.ProcessEnv, homedir?: () => string): string;
export declare function resolveRequiredOsHomeDir(env?: NodeJS.ProcessEnv, homedir?: () => string): string;
export declare function expandHomePrefix(input: string, opts?: {
    home?: string;
    env?: NodeJS.ProcessEnv;
    homedir?: () => string;
}): string;
export declare function resolveHomeRelativePath(input: string, opts?: {
    env?: NodeJS.ProcessEnv;
    homedir?: () => string;
}): string;
export declare function resolveOsHomeRelativePath(input: string, opts?: {
    env?: NodeJS.ProcessEnv;
    homedir?: () => string;
}): string;
