import { type ParsedRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import type { PluginPackageInstall } from "./manifest.js";
export type PluginInstallSourceWarning = "invalid-npm-spec" | "invalid-default-choice" | "default-choice-missing-source" | "npm-integrity-without-source" | "npm-spec-floating" | "npm-spec-missing-integrity" | "npm-spec-package-name-mismatch";
export type PluginInstallNpmPinState = "exact-with-integrity" | "exact-without-integrity" | "floating-with-integrity" | "floating-without-integrity";
export type PluginInstallNpmSourceInfo = {
    spec: string;
    packageName: string;
    expectedPackageName?: string;
    selector?: string;
    selectorKind: ParsedRegistryNpmSpec["selectorKind"];
    exactVersion: boolean;
    expectedIntegrity?: string;
    pinState: PluginInstallNpmPinState;
};
export type PluginInstallLocalSourceInfo = {
    path: string;
};
export type PluginInstallSourceInfo = {
    defaultChoice?: PluginPackageInstall["defaultChoice"];
    npm?: PluginInstallNpmSourceInfo;
    local?: PluginInstallLocalSourceInfo;
    warnings: readonly PluginInstallSourceWarning[];
};
export type DescribePluginInstallSourceOptions = {
    expectedPackageName?: string | null;
};
export declare function describePluginInstallSource(install: PluginPackageInstall, options?: DescribePluginInstallSourceOptions): PluginInstallSourceInfo;
