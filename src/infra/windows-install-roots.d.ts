type QueryRegistryValue = (key: string, valueName: string) => string | null;
type IsReadableFile = (filePath: string) => boolean;
type WindowsInstallRootsTestOverrides = {
    queryRegistryValue?: QueryRegistryValue;
    isReadableFile?: IsReadableFile;
};
export type WindowsInstallRoots = {
    systemRoot: string;
    programFiles: string;
    programFilesX86: string;
    programW6432: string | null;
};
/**
 * Windows install roots should be local absolute directories, not drive-relative
 * paths, UNC shares, or PATH-like lists that could widen trust unexpectedly.
 */
export declare function normalizeWindowsInstallRoot(raw: string | undefined): string | null;
declare function getWindowsRegExeCandidates(env: Record<string, string | undefined>): readonly string[];
declare function locateWindowsRegExe(env?: Record<string, string | undefined>): string | null;
export declare function getWindowsInstallRoots(env?: Record<string, string | undefined>): WindowsInstallRoots;
export declare function getWindowsProgramFilesRoots(env?: Record<string, string | undefined>): readonly string[];
export declare function _resetWindowsInstallRootsForTests(overrides?: WindowsInstallRootsTestOverrides): void;
export declare const _private: {
    getWindowsRegExeCandidates: typeof getWindowsRegExeCandidates;
    locateWindowsRegExe: typeof locateWindowsRegExe;
};
export {};
