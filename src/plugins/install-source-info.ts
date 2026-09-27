/** Describes package-authored plugin install source metadata and pinning warnings. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import { isExactSemverVersion, parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import type {
  PluginInstallSourceInfo,
  PluginInstallSourceWarning,
  PluginInstallNpmSourceInfo,
  PluginInstallClawHubSourceInfo,
} from "./install-source-info.types.js";
import type { PluginPackageInstall } from "./package-manifest.types.js";
import { normalizePluginInstallDefaultChoice } from "./plugin-install-default-choice.js";

export type { PluginInstallSourceInfo } from "./install-source-info.types.js";

function normalizeExpectedPackageName(value: string | null | undefined): string | undefined {
  const expected = normalizeOptionalString(value);
  if (!expected) {
    return undefined;
  }
  return parseRegistryNpmSpec(expected)?.name ?? expected;
}

/** Describes plugin install source metadata and warnings without mutating manifests. */
export function describePluginInstallSource(
  install: PluginPackageInstall,
  options?: { expectedPackageName?: string | null },
): PluginInstallSourceInfo {
  const clawhubSpec = normalizeOptionalString(install.clawhubSpec);
  const npmSpec = normalizeOptionalString(install.npmSpec);
  const localPath = normalizeOptionalString(install.localPath);
  const defaultChoice = normalizePluginInstallDefaultChoice(install.defaultChoice);
  const expectedIntegrity = normalizeOptionalString(install.expectedIntegrity);
  const expectedPackageName = normalizeExpectedPackageName(options?.expectedPackageName);
  const warnings: PluginInstallSourceWarning[] = [];
  let clawhub: PluginInstallClawHubSourceInfo | undefined;
  let npm: PluginInstallNpmSourceInfo | undefined;

  if (install.defaultChoice !== undefined && !defaultChoice) {
    warnings.push("invalid-default-choice");
  }

  if (clawhubSpec) {
    const parsed = parseClawHubPluginSpec(clawhubSpec);
    if (parsed) {
      const exactVersion = parsed.version ? isExactSemverVersion(parsed.version) : false;
      if (!exactVersion) {
        warnings.push("clawhub-spec-floating");
      }
      clawhub = {
        spec: clawhubSpec,
        packageName: parsed.name,
        ...(parsed.version ? { version: parsed.version } : {}),
        exactVersion,
      };
    } else {
      warnings.push("invalid-clawhub-spec");
    }
  }

  if (npmSpec) {
    const parsed = parseRegistryNpmSpec(npmSpec);
    if (parsed) {
      const exactVersion = parsed.selectorKind === "exact-version";
      const hasIntegrity = Boolean(expectedIntegrity);
      if (!exactVersion) {
        warnings.push("npm-spec-floating");
      }
      if (!hasIntegrity) {
        warnings.push("npm-spec-missing-integrity");
      }
      if (expectedPackageName && parsed.name !== expectedPackageName) {
        warnings.push("npm-spec-package-name-mismatch");
      }
      npm = {
        spec: parsed.raw,
        packageName: parsed.name,
        ...(expectedPackageName && parsed.name !== expectedPackageName
          ? { expectedPackageName }
          : {}),
        selectorKind: parsed.selectorKind,
        exactVersion,
        pinState: `${exactVersion ? "exact" : "floating"}-${hasIntegrity ? "with" : "without"}-integrity`,
        ...(parsed.selector ? { selector: parsed.selector } : {}),
        ...(expectedIntegrity ? { expectedIntegrity } : {}),
      };
    } else {
      warnings.push("invalid-npm-spec");
    }
  }
  if (
    (defaultChoice === "clawhub" && !clawhub) ||
    (defaultChoice === "npm" && !npm) ||
    (defaultChoice === "local" && !localPath)
  ) {
    warnings.push("default-choice-missing-source");
  }
  if (expectedIntegrity && !npm) {
    warnings.push("npm-integrity-without-source");
  }

  return {
    ...(defaultChoice ? { defaultChoice } : {}),
    ...(clawhub ? { clawhub } : {}),
    ...(npm ? { npm } : {}),
    ...(localPath ? { local: { path: localPath } } : {}),
    warnings,
  };
}
