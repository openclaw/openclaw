import fs from "node:fs/promises";
import path from "node:path";
import type { NpmSpecResolution } from "./install-source-utils.js";
import { readJson, readJsonIfExists, writeJson } from "./json-files.js";
import type { ParsedRegistryNpmSpec } from "./npm-registry-spec.js";

type ManagedNpmRootManifest = {
  private?: boolean;
  dependencies?: Record<string, string>;
  [key: string]: unknown;
};

export type ManagedNpmRootInstalledDependency = {
  version?: string;
  integrity?: string;
  resolved?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readDependencyRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  const dependencies: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string") {
      dependencies[key] = raw;
    }
  }
  return dependencies;
}

async function readManagedNpmRootManifest(filePath: string): Promise<ManagedNpmRootManifest> {
  const parsed = await readJsonIfExists<unknown>(filePath);
  return isRecord(parsed) ? { ...parsed } : {};
}

export function resolveManagedNpmRootDependencySpec(params: {
  parsedSpec: ParsedRegistryNpmSpec;
  resolution: NpmSpecResolution;
}): string {
  return params.resolution.version ?? params.parsedSpec.selector ?? "latest";
}

export async function upsertManagedNpmRootDependency(params: {
  npmRoot: string;
  packageName: string;
  dependencySpec: string;
}): Promise<void> {
  await fs.mkdir(params.npmRoot, { recursive: true });
  const manifestPath = path.join(params.npmRoot, "package.json");
  const manifest = await readManagedNpmRootManifest(manifestPath);
  const dependencies = readDependencyRecord(manifest.dependencies);
  const next: ManagedNpmRootManifest = {
    ...manifest,
    private: true,
    dependencies: {
      ...dependencies,
      [params.packageName]: params.dependencySpec,
    },
  };
  await writeJson(manifestPath, next, { trailingNewline: true });
}

export async function readManagedNpmRootInstalledDependency(params: {
  npmRoot: string;
  packageName: string;
}): Promise<ManagedNpmRootInstalledDependency | null> {
  const lockPath = path.join(params.npmRoot, "package-lock.json");
  const parsed = await readJson<unknown>(lockPath);
  if (!isRecord(parsed) || !isRecord(parsed.packages)) {
    return null;
  }
  const entry = parsed.packages[`node_modules/${params.packageName}`];
  if (!isRecord(entry)) {
    return null;
  }
  return {
    version: readOptionalString(entry.version),
    integrity: readOptionalString(entry.integrity),
    resolved: readOptionalString(entry.resolved),
  };
}

export async function removeManagedNpmRootDependency(params: {
  npmRoot: string;
  packageName: string;
}): Promise<void> {
  const manifestPath = path.join(params.npmRoot, "package.json");
  const manifest = await readManagedNpmRootManifest(manifestPath);
  const dependencies = readDependencyRecord(manifest.dependencies);
  if (!(params.packageName in dependencies)) {
    return;
  }
  const { [params.packageName]: _removed, ...nextDependencies } = dependencies;
  const next: ManagedNpmRootManifest = {
    ...manifest,
    private: true,
    dependencies: nextDependencies,
  };
  await writeJson(manifestPath, next, { trailingNewline: true });
}
