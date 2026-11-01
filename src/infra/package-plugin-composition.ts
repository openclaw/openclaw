import { satisfies, valid } from "semver";
import { listBundleDependencies } from "../../scripts/lib/package-bundle-dependencies.mts";
import { validateBundledPackageDependencyAlignment } from "../../scripts/package-source-dependencies.mjs";

export type DistributionPackageManifest = {
  name: string;
  version: string;
  files?: string[];
  bundleDependencies?: string[] | boolean;
  bundledDependencies?: string[] | boolean;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

/** Shared dependency ownership for release packages and private node distributions. */
export function composePackagePlugins<T extends DistributionPackageManifest>(
  packageJson: T,
  plugins: readonly { id: string; packageJson: DistributionPackageManifest }[],
): Omit<T, "bundleDependencies" | "bundledDependencies"> &
  Pick<DistributionPackageManifest, "bundleDependencies" | "bundledDependencies"> {
  const composed = structuredClone(packageJson);
  const bundled = new Set<string>();
  for (const { id, packageJson: plugin } of plugins) {
    for (const name of listBundleDependencies(plugin)) {
      bundled.add(name);
    }
    for (const section of ["dependencies", "optionalDependencies"] as const) {
      const dependencies = plugin[section] ?? {};
      for (const [name, spec] of Object.entries(dependencies)) {
        if (valid(spec) !== spec) {
          throw new Error(
            `Selected plugin ${id} requires an exact dependency pin: ${name}@${spec}`,
          );
        }
      }
      for (const existing of [composed.dependencies, composed.optionalDependencies]) {
        validateBundledPackageDependencyAlignment({
          bundledDependencies: dependencies,
          bundledPackageLabel: `selected plugin ${id}`,
          rootDependencies: { ...dependencies, ...existing },
        });
      }
      composed[section] = { ...composed[section], ...dependencies };
    }
  }
  for (const name of listBundleDependencies(composed)) {
    bundled.add(name);
  }
  if (bundled.size > 0) {
    composed.bundleDependencies = [...bundled].toSorted();
    delete composed.bundledDependencies;
  }
  // A required dependency cannot stay optional when another selected owner needs it.
  for (const name of Object.keys(composed.dependencies ?? {})) {
    delete composed.optionalDependencies?.[name];
  }
  for (const { id, packageJson: plugin } of plugins) {
    for (const [name, range] of Object.entries(plugin.peerDependencies ?? {})) {
      const version =
        name === composed.name
          ? composed.version
          : (composed.dependencies?.[name] ?? composed.optionalDependencies?.[name]);
      if (
        (!version && !plugin.peerDependenciesMeta?.[name]?.optional) ||
        (version && !satisfies(version, range))
      ) {
        throw new Error(`Selected plugin ${id} requires peer ${name}@${range} in the distribution`);
      }
    }
  }
  const exclusions = new Set(plugins.map(({ id }) => `!dist/extensions/${id}/**`));
  if (composed.files) {
    composed.files = composed.files.filter((entry) => !exclusions.has(entry));
  }
  return composed;
}
