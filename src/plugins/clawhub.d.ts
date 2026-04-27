import { type ClawHubPackageChannel, type ClawHubPackageFamily } from "../infra/clawhub.js";
import type { InstallSafetyOverrides } from "./install-security-scan.js";
import { type InstallPluginResult } from "./install.js";
export declare const CLAWHUB_INSTALL_ERROR_CODE: {
    readonly INVALID_SPEC: "invalid_spec";
    readonly PACKAGE_NOT_FOUND: "package_not_found";
    readonly VERSION_NOT_FOUND: "version_not_found";
    readonly NO_INSTALLABLE_VERSION: "no_installable_version";
    readonly SKILL_PACKAGE: "skill_package";
    readonly UNSUPPORTED_FAMILY: "unsupported_family";
    readonly PRIVATE_PACKAGE: "private_package";
    readonly INCOMPATIBLE_PLUGIN_API: "incompatible_plugin_api";
    readonly INCOMPATIBLE_GATEWAY: "incompatible_gateway";
    readonly MISSING_ARCHIVE_INTEGRITY: "missing_archive_integrity";
    readonly ARCHIVE_INTEGRITY_MISMATCH: "archive_integrity_mismatch";
};
export type ClawHubInstallErrorCode = (typeof CLAWHUB_INSTALL_ERROR_CODE)[keyof typeof CLAWHUB_INSTALL_ERROR_CODE];
type PluginInstallLogger = {
    info?: (message: string) => void;
    warn?: (message: string) => void;
};
export type ClawHubPluginInstallRecordFields = {
    source: "clawhub";
    clawhubUrl: string;
    clawhubPackage: string;
    clawhubFamily: Exclude<ClawHubPackageFamily, "skill">;
    clawhubChannel?: ClawHubPackageChannel;
    version?: string;
    integrity?: string;
    resolvedAt?: string;
    installedAt?: string;
};
type ClawHubInstallFailure = {
    ok: false;
    error: string;
    code?: ClawHubInstallErrorCode;
};
export declare function formatClawHubSpecifier(params: {
    name: string;
    version?: string;
}): string;
export declare function installPluginFromClawHub(params: InstallSafetyOverrides & {
    spec: string;
    baseUrl?: string;
    token?: string;
    logger?: PluginInstallLogger;
    mode?: "install" | "update";
    dryRun?: boolean;
    expectedPluginId?: string;
}): Promise<({
    ok: true;
} & Extract<InstallPluginResult, {
    ok: true;
}> & {
    clawhub: ClawHubPluginInstallRecordFields;
    packageName: string;
}) | ClawHubInstallFailure | Extract<InstallPluginResult, {
    ok: false;
}>>;
export {};
