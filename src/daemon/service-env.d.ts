import { isNodeVersionManagerRuntime, resolveLinuxSystemCaBundle } from "../bootstrap/node-extra-ca-certs.js";
export { isNodeVersionManagerRuntime, resolveLinuxSystemCaBundle };
export type MinimalServicePathOptions = {
    platform?: NodeJS.Platform;
    extraDirs?: string[];
    home?: string;
    env?: Record<string, string | undefined>;
};
type BuildServicePathOptions = MinimalServicePathOptions & {
    env?: Record<string, string | undefined>;
};
/**
 * Resolve common user bin directories for macOS.
 * These are paths where npm global installs and node version managers typically place binaries.
 *
 * Key differences from Linux:
 * - fnm: macOS uses ~/Library/Application Support/fnm (not ~/.local/share/fnm)
 * - pnpm: macOS uses ~/Library/pnpm (not ~/.local/share/pnpm)
 */
export declare function resolveDarwinUserBinDirs(home: string | undefined, env?: Record<string, string | undefined>): string[];
/**
 * Resolve common user bin directories for Linux.
 * These are paths where npm global installs and node version managers typically place binaries.
 */
export declare function resolveLinuxUserBinDirs(home: string | undefined, env?: Record<string, string | undefined>): string[];
export declare function getMinimalServicePathParts(options?: MinimalServicePathOptions): string[];
export declare function getMinimalServicePathPartsFromEnv(options?: BuildServicePathOptions): string[];
export declare function buildMinimalServicePath(options?: BuildServicePathOptions): string;
export declare function buildServiceEnvironment(params: {
    env: Record<string, string | undefined>;
    port: number;
    launchdLabel?: string;
    platform?: NodeJS.Platform;
    extraPathDirs?: string[];
    execPath?: string;
}): Record<string, string | undefined>;
export declare function buildNodeServiceEnvironment(params: {
    env: Record<string, string | undefined>;
    platform?: NodeJS.Platform;
    extraPathDirs?: string[];
    execPath?: string;
}): Record<string, string | undefined>;
