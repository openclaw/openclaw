import fs from "node:fs/promises";
import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { tryReadJson } from "../infra/json-files.js";
import { isPackageDependencyName } from "../infra/package-json.js";
import { statIfExists } from "../infra/path-existence.js";

export type InstalledRuntimePackageRoot = {
  packageDir: string;
  realPath: string;
};

export type InstalledRuntimePackageGraph = {
  packageDirs: string[];
  incomplete: Map<string, string[]>;
};

function runtimeDependencies(
  manifest: Record<string, unknown>,
  incomplete: (message: string) => void,
): Array<{ name: string; optional: boolean }> {
  const dependencies = new Map<string, boolean>();
  const peerMetadata = asNullableRecord(manifest.peerDependenciesMeta);
  if (manifest.peerDependenciesMeta !== undefined && !peerMetadata) {
    incomplete("Invalid peerDependenciesMeta map; expected an object.");
  }
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
    if (manifest[field] === undefined) {
      continue;
    }
    const entries = asNullableRecord(manifest[field]);
    if (!entries) {
      incomplete(`Invalid ${field} map; expected an object.`);
      continue;
    }
    for (const [name, specifier] of Object.entries(entries)) {
      if (field === "peerDependencies" && name === "openclaw") {
        continue;
      }
      if (!isPackageDependencyName(name)) {
        incomplete(`Invalid ${field} package name ${JSON.stringify(name)}.`);
        continue;
      }
      if (typeof specifier !== "string") {
        incomplete(`Invalid dependency specifier for ${JSON.stringify(name)}; expected a string.`);
      }
      const metadataValue = peerMetadata?.[name];
      const metadata = asNullableRecord(metadataValue);
      if (
        field === "peerDependencies" &&
        metadataValue !== undefined &&
        (!metadata || (metadata.optional !== undefined && typeof metadata.optional !== "boolean"))
      ) {
        incomplete(`Invalid peerDependenciesMeta entry for ${JSON.stringify(name)}.`);
      }
      const optional =
        field === "optionalDependencies" ||
        (field === "peerDependencies" && metadata?.optional === true);
      if (field !== "peerDependencies" || !dependencies.has(name) || !optional) {
        dependencies.set(name, optional);
      }
    }
  }
  return [...dependencies]
    .map(([name, optional]) => ({ name, optional }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

/** Resolve manifest-owned runtime dependencies without importing package code. */
export async function collectInstalledRuntimePackageGraph(params: {
  packageDir: string;
  additionalPackageDirs?: readonly string[];
  lookupRootDir?: string;
  maxPackages?: number;
  admitPackage?: (candidate: InstalledRuntimePackageRoot & { dependencyName?: string }) => boolean;
}): Promise<InstalledRuntimePackageGraph> {
  const rawLookupRoot = params.lookupRootDir;
  const lookupRoot = rawLookupRoot
    ? await fs.realpath(rawLookupRoot).catch(() => path.resolve(rawLookupRoot))
    : undefined;
  const queue: InstalledRuntimePackageRoot[] = [];
  for (const packageDir of [params.packageDir, ...(params.additionalPackageDirs ?? [])]) {
    const realPath = await fs.realpath(packageDir).catch(() => path.resolve(packageDir));
    const candidate = { packageDir, realPath };
    if (params.admitPackage?.(candidate) !== false) {
      queue.push(candidate);
    }
  }
  const visited = new Set<string>();
  const roots: string[] = [];
  const incomplete = new Map<string, string[]>();
  async function resolveDependency(
    from: string,
    dependencyName: string,
  ): Promise<InstalledRuntimePackageRoot | "excluded" | undefined> {
    let directory = from;
    while (true) {
      if (path.basename(directory) !== "node_modules") {
        const packageDir = path.join(directory, "node_modules", dependencyName);
        const stats = await statIfExists(packageDir);
        if (stats?.isDirectory()) {
          const candidate = {
            packageDir,
            realPath: await fs.realpath(packageDir).catch(() => path.resolve(packageDir)),
          };
          return params.admitPackage?.({ ...candidate, dependencyName }) === false
            ? "excluded"
            : candidate;
        }
      }
      if (directory === lookupRoot || path.dirname(directory) === directory) {
        return undefined;
      }
      directory = path.dirname(directory);
    }
  }
  for (const current of queue) {
    if (visited.has(current.realPath)) {
      continue;
    }
    visited.add(current.realPath);
    if (visited.size > (params.maxPackages ?? 10_000)) {
      throw new Error(
        `installed dependency scan exceeded max packages (${params.maxPackages ?? 10_000}) under ${params.lookupRootDir ?? params.packageDir}`,
      );
    }
    roots.push(current.packageDir);
    const manifest = asNullableRecord(
      await tryReadJson<unknown>(path.join(current.packageDir, "package.json")),
    );
    if (!manifest) {
      continue;
    }
    const reportIncomplete = (message: string) => {
      const messages = incomplete.get(current.packageDir) ?? [];
      messages.push(message);
      incomplete.set(current.packageDir, messages);
    };
    for (const { name, optional } of runtimeDependencies(manifest, reportIncomplete)) {
      // Node resolves from the package's physical directory, including pnpm peer/hoist layouts.
      const candidate = await resolveDependency(current.realPath, name);
      if (candidate === "excluded") {
        continue;
      }
      if (candidate && !visited.has(candidate.realPath)) {
        queue.push(candidate);
      } else if (!candidate && !optional && name !== "openclaw") {
        // The host-link owner supplies absent OpenClaw dependencies after admission.
        reportIncomplete(
          `Missing required runtime dependency ${JSON.stringify(name)}; install package dependencies before qualification.`,
        );
      }
    }
  }
  return { packageDirs: roots, incomplete };
}
