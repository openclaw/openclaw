import type { InstallSafetyOverrides } from "./install-security-scan.types.js";
type InstallScanLogger = {
    warn?: (message: string) => void;
};
type PluginInstallRequestKind = "skill-install" | "plugin-dir" | "plugin-archive" | "plugin-file" | "plugin-npm";
type SkillInstallSpec = {
    id?: string;
    kind: "brew" | "node" | "go" | "uv" | "download";
    label?: string;
    bins?: string[];
    os?: string[];
    formula?: string;
    package?: string;
    module?: string;
    url?: string;
    archive?: string;
    extract?: boolean;
    stripComponents?: number;
    targetDir?: string;
};
export type InstallSecurityScanResult = {
    blocked?: {
        code?: "security_scan_blocked" | "security_scan_failed";
        reason: string;
    };
};
export declare function scanBundleInstallSourceRuntime(params: InstallSafetyOverrides & {
    logger: InstallScanLogger;
    pluginId: string;
    sourceDir: string;
    requestKind?: PluginInstallRequestKind;
    requestedSpecifier?: string;
    mode?: "install" | "update";
    version?: string;
}): Promise<InstallSecurityScanResult | undefined>;
export declare function scanPackageInstallSourceRuntime(params: InstallSafetyOverrides & {
    extensions: string[];
    logger: InstallScanLogger;
    packageDir: string;
    pluginId: string;
    requestKind?: PluginInstallRequestKind;
    requestedSpecifier?: string;
    mode?: "install" | "update";
    packageName?: string;
    manifestId?: string;
    version?: string;
}): Promise<InstallSecurityScanResult | undefined>;
export declare function scanInstalledPackageDependencyTreeRuntime(params: {
    logger: InstallScanLogger;
    packageDir: string;
    pluginId: string;
}): Promise<InstallSecurityScanResult | undefined>;
export declare function scanFileInstallSourceRuntime(params: InstallSafetyOverrides & {
    filePath: string;
    logger: InstallScanLogger;
    mode?: "install" | "update";
    pluginId: string;
    requestedSpecifier?: string;
}): Promise<InstallSecurityScanResult | undefined>;
export declare function scanSkillInstallSourceRuntime(params: {
    dangerouslyForceUnsafeInstall?: boolean;
    installId: string;
    installSpec?: SkillInstallSpec;
    logger: InstallScanLogger;
    origin: string;
    skillName: string;
    sourceDir: string;
}): Promise<InstallSecurityScanResult | undefined>;
export {};
