import { parseRegistryNpmSpec, type ParsedRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import type { PluginPackageInstall } from "./manifest.js";

export type PluginInstallSourceWarning =
  | "invalid-npm-spec"
  | "npm-spec-floating"
  | "npm-spec-missing-integrity";

export type PluginInstallNpmPinState =
  | "exact-with-integrity"
  | "exact-without-integrity"
  | "floating-with-integrity"
  | "floating-without-integrity";

export type PluginInstallNpmSourceInfo = {
  spec: string;
  packageName: string;
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

function resolveNpmPinState(params: {
  exactVersion: boolean;
  hasIntegrity: boolean;
}): PluginInstallNpmPinState {
  if (params.exactVersion) {
    return params.hasIntegrity ? "exact-with-integrity" : "exact-without-integrity";
  }
  return params.hasIntegrity ? "floating-with-integrity" : "floating-without-integrity";
}

export function describePluginInstallSource(
  install: PluginPackageInstall,
): PluginInstallSourceInfo {
  const npmSpec = install.npmSpec?.trim();
  const localPath = install.localPath?.trim();
  const warnings: PluginInstallSourceWarning[] = [];
  let npm: PluginInstallNpmSourceInfo | undefined;

  if (npmSpec) {
    const parsed = parseRegistryNpmSpec(npmSpec);
    if (parsed) {
      const exactVersion = parsed.selectorKind === "exact-version";
      const expectedIntegrity = install.expectedIntegrity?.trim();
      const hasIntegrity = Boolean(expectedIntegrity);
      if (!exactVersion) {
        warnings.push("npm-spec-floating");
      }
      if (!hasIntegrity) {
        warnings.push("npm-spec-missing-integrity");
      }
      npm = {
        spec: parsed.raw,
        packageName: parsed.name,
        selectorKind: parsed.selectorKind,
        exactVersion,
        pinState: resolveNpmPinState({ exactVersion, hasIntegrity }),
        ...(parsed.selector ? { selector: parsed.selector } : {}),
        ...(expectedIntegrity ? { expectedIntegrity } : {}),
      };
    } else {
      warnings.push("invalid-npm-spec");
    }
  }

  return {
    ...(install.defaultChoice ? { defaultChoice: install.defaultChoice } : {}),
    ...(npm ? { npm } : {}),
    ...(localPath ? { local: { path: localPath } } : {}),
    warnings,
  };
}
