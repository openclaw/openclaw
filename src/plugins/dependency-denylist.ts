const BLOCKED_INSTALL_DEPENDENCY_PACKAGE_NAMES = ["plain-crypto-js"] as const;

export const blockedInstallDependencyPackageNames = [
  ...BLOCKED_INSTALL_DEPENDENCY_PACKAGE_NAMES,
] as const;

export type BlockedManifestDependencyFinding = {
  dependencyName: string;
  declaredAs?: string;
  field: "dependencies" | "name" | "optionalDependencies" | "peerDependencies";
};

type PackageDependencyFields = {
  name?: string;
} & Partial<
  Record<Exclude<BlockedManifestDependencyFinding["field"], "name">, Record<string, string>>
>;

const BLOCKED_INSTALL_DEPENDENCY_PACKAGE_NAME_SET = new Set<string>(
  blockedInstallDependencyPackageNames,
);

function parseNpmAliasTargetPackageName(spec: string): string | undefined {
  const normalized = spec.trim();
  if (!normalized.startsWith("npm:")) {
    return undefined;
  }

  const aliasTarget = normalized.slice("npm:".length).trim();
  if (!aliasTarget) {
    return undefined;
  }

  if (aliasTarget.startsWith("@")) {
    const slashIndex = aliasTarget.indexOf("/");
    if (slashIndex < 0) {
      return undefined;
    }
    const versionSeparatorIndex = aliasTarget.indexOf("@", slashIndex + 1);
    return versionSeparatorIndex < 0 ? aliasTarget : aliasTarget.slice(0, versionSeparatorIndex);
  }

  const versionSeparatorIndex = aliasTarget.indexOf("@");
  return versionSeparatorIndex < 0 ? aliasTarget : aliasTarget.slice(0, versionSeparatorIndex);
}

export function findBlockedManifestDependencies(
  manifest: PackageDependencyFields,
): BlockedManifestDependencyFinding[] {
  const findings: BlockedManifestDependencyFinding[] = [];
  if (manifest.name && BLOCKED_INSTALL_DEPENDENCY_PACKAGE_NAME_SET.has(manifest.name)) {
    findings.push({ dependencyName: manifest.name, field: "name" });
  }
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
    const dependencyMap = manifest[field];
    if (!dependencyMap) {
      continue;
    }
    for (const dependencyName of Object.keys(dependencyMap).toSorted()) {
      if (BLOCKED_INSTALL_DEPENDENCY_PACKAGE_NAME_SET.has(dependencyName)) {
        findings.push({ dependencyName, field });
        continue;
      }

      const aliasTargetPackageName = parseNpmAliasTargetPackageName(dependencyMap[dependencyName]);
      if (!aliasTargetPackageName) {
        continue;
      }
      if (!BLOCKED_INSTALL_DEPENDENCY_PACKAGE_NAME_SET.has(aliasTargetPackageName)) {
        continue;
      }
      findings.push({
        dependencyName: aliasTargetPackageName,
        declaredAs: dependencyName,
        field,
      });
    }
  }
  return findings;
}
