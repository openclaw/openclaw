const BLOCKED_INSTALL_DEPENDENCY_PACKAGE_NAMES = ["plain-crypto-js"] as const;

export const blockedInstallDependencyPackageNames = [
  ...BLOCKED_INSTALL_DEPENDENCY_PACKAGE_NAMES,
] as const;

export type BlockedManifestDependencyFinding = {
  dependencyName: string;
  field: "dependencies" | "optionalDependencies" | "peerDependencies";
};

type PackageDependencyFields = Partial<
  Record<BlockedManifestDependencyFinding["field"], Record<string, string>>
>;

const BLOCKED_INSTALL_DEPENDENCY_PACKAGE_NAME_SET = new Set<string>(
  blockedInstallDependencyPackageNames,
);

export function findBlockedManifestDependencies(
  manifest: PackageDependencyFields,
): BlockedManifestDependencyFinding[] {
  const findings: BlockedManifestDependencyFinding[] = [];
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
    const dependencyMap = manifest[field];
    if (!dependencyMap) {
      continue;
    }
    for (const dependencyName of Object.keys(dependencyMap).toSorted()) {
      if (!BLOCKED_INSTALL_DEPENDENCY_PACKAGE_NAME_SET.has(dependencyName)) {
        continue;
      }
      findings.push({ dependencyName, field });
    }
  }
  return findings;
}
