// Collects core dependency status for plugin diagnostics.
import fs from "node:fs";
import path from "node:path";
import { readRootJsonObjectSync } from "../infra/json-files.js";
import type { PluginDiagnostic } from "./manifest-types.js";
import { isPathInside, safeRealpathSync } from "./path-safety.js";
import { auditOpenClawPeerDependencyLinkSync } from "./plugin-peer-link.js";
import type {
  PluginDependencyEntry,
  PluginDependencySpecMap,
  PluginDependencyStatus,
} from "./status-dependencies.types.js";

const MAX_DEPENDENCY_MANIFEST_BYTES = 1024 * 1024;

export type PluginDependencyHealthRegistry = {
  plugins: Array<{
    id: string;
    source: string;
    enabled: boolean;
    origin?: string;
    packageName?: string;
    rootDir?: string;
    status: "loaded" | "disabled" | "error";
    error?: string;
    dependencyStatus?: PluginDependencyStatus;
  }>;
  diagnostics: PluginDiagnostic[];
};

function normalizeDependencyMap(raw: unknown): PluginDependencySpecMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const normalized: PluginDependencySpecMap = {};
  for (const [name, spec] of Object.entries(raw)) {
    const normalizedName = name.trim();
    if (!normalizedName || typeof spec !== "string" || !spec.trim()) {
      continue;
    }
    normalized[normalizedName] = spec.trim();
  }
  return normalized;
}

/** Normalizes raw package dependency maps into sorted plugin dependency specs. */
export function normalizePluginDependencySpecs(params: {
  dependencies?: unknown;
  optionalDependencies?: unknown;
}): {
  dependencies: PluginDependencySpecMap;
  optionalDependencies: PluginDependencySpecMap;
} {
  const dependencies = normalizeDependencyMap(params.dependencies);
  const optionalDependencies = normalizeDependencyMap(params.optionalDependencies);
  for (const name of Object.keys(optionalDependencies)) {
    delete dependencies[name];
  }
  return {
    dependencies,
    optionalDependencies,
  };
}

function dependencyPathSegments(name: string): string[] | null {
  const segments = name.split("/");
  if (segments.length === 1 && segments[0]) {
    return [segments[0]];
  }
  if (segments.length === 2 && segments[0]?.startsWith("@") && segments[1]) {
    return segments;
  }
  return null;
}

function findDependencyPackageDir(params: {
  fromDir: string;
  name: string;
  dependencyRootDir?: string;
}): string | undefined {
  const segments = dependencyPathSegments(params.name);
  if (!segments) {
    return undefined;
  }
  const boundaryRoot =
    params.dependencyRootDir === undefined
      ? undefined
      : (safeRealpathSync(params.dependencyRootDir) ?? path.resolve(params.dependencyRootDir));
  let current = path.resolve(params.fromDir);
  if (boundaryRoot) {
    current = safeRealpathSync(current) ?? current;
  }
  while (true) {
    if (boundaryRoot && !isPathInside(boundaryRoot, current)) {
      return undefined;
    }
    const candidate = path.join(current, "node_modules", ...segments);
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      const resolved = safeRealpathSync(candidate);
      const manifestPath = safeRealpathSync(path.join(candidate, "package.json"));
      if (
        !resolved ||
        !manifestPath ||
        (boundaryRoot &&
          (!isPathInside(boundaryRoot, resolved) || !isPathInside(boundaryRoot, manifestPath)))
      ) {
        return undefined;
      }
      // Resolve in-project links before the reader's regular-file admission.
      const manifestRoot = boundaryRoot ?? path.dirname(manifestPath);
      const manifest = readRootJsonObjectSync({
        rootDir: manifestRoot,
        relativePath: path.relative(manifestRoot, manifestPath),
        boundaryLabel: "plugin dependency project",
        maxBytes: MAX_DEPENDENCY_MANIFEST_BYTES,
        // Package stores may hardlink valid manifests into the managed project.
        rejectHardlinks: false,
      });
      // A present but unusable nearer manifest must not be hidden by hoisting.
      return manifest.ok ? candidate : undefined;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function buildDependencyEntries(params: {
  rootDir: string | undefined;
  dependencyRootDir?: string;
  dependencies: PluginDependencySpecMap;
  optional: boolean;
}): PluginDependencyEntry[] {
  return Object.entries(params.dependencies)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([name, spec]) => {
      const resolvedPath = params.rootDir
        ? findDependencyPackageDir({
            fromDir: params.rootDir,
            name,
            dependencyRootDir: params.dependencyRootDir,
          })
        : undefined;
      const entry: PluginDependencyEntry = {
        name,
        spec,
        installed: resolvedPath !== undefined,
        optional: params.optional,
      };
      if (resolvedPath) {
        entry.resolvedPath = resolvedPath;
      }
      return entry;
    });
}

/** Builds dependency installation status for a plugin package root. */
export function buildPluginDependencyStatus(params: {
  rootDir?: string;
  /** Confines managed dependency lookup and symlink targets to this project root. */
  dependencyRootDir?: string;
  dependencies?: PluginDependencySpecMap;
  optionalDependencies?: PluginDependencySpecMap;
}): PluginDependencyStatus {
  const dependencies = buildDependencyEntries({
    rootDir: params.rootDir,
    dependencyRootDir: params.dependencyRootDir,
    dependencies: params.dependencies ?? {},
    optional: false,
  });
  const optionalDependencies = buildDependencyEntries({
    rootDir: params.rootDir,
    dependencyRootDir: params.dependencyRootDir,
    dependencies: params.optionalDependencies ?? {},
    optional: true,
  });
  const missing = dependencies.filter((entry) => !entry.installed).map((entry) => entry.name);
  const missingOptional = optionalDependencies
    .filter((entry) => !entry.installed)
    .map((entry) => entry.name);
  const requiredInstalled = missing.length === 0;
  const optionalInstalled = missingOptional.length === 0;
  return {
    hasDependencies: dependencies.length > 0 || optionalDependencies.length > 0,
    installed: requiredInstalled,
    requiredInstalled,
    optionalInstalled,
    missing,
    missingOptional,
    dependencies,
    optionalDependencies,
  };
}

/** Checks managed required dependencies, using the host audit for the OpenClaw SDK link. */
export function buildManagedPluginDependencyStatus(params: {
  rootDir: string;
  dependencyRootDir: string;
  dependencies?: PluginDependencySpecMap;
  optionalDependencies?: PluginDependencySpecMap;
}): PluginDependencyStatus {
  const status = buildPluginDependencyStatus(params);
  if (!status.dependencies.some((entry) => entry.name === "openclaw")) {
    return status;
  }

  const rootDir = safeRealpathSync(params.rootDir);
  const boundaryRoot = safeRealpathSync(params.dependencyRootDir);
  let hostInstalled = false;
  if (rootDir && boundaryRoot && isPathInside(boundaryRoot, rootDir)) {
    // The canonical host may live outside this project. Audit its identity even
    // when an in-project copy would satisfy the ordinary dependency lookup.
    hostInstalled = auditOpenClawPeerDependencyLinkSync({ packageDir: rootDir }) === null;
  }
  const dependencies = status.dependencies.map((entry) =>
    entry.name === "openclaw"
      ? {
          ...entry,
          installed: hostInstalled,
          resolvedPath: hostInstalled
            ? path.join(params.rootDir, "node_modules", "openclaw")
            : undefined,
        }
      : entry,
  );
  const missing = dependencies.filter((entry) => !entry.installed).map((entry) => entry.name);
  return {
    ...status,
    dependencies,
    missing,
    installed: missing.length === 0,
    requiredInstalled: missing.length === 0,
  };
}

export async function findMissingRequiredPluginDependencies(
  params: Parameters<typeof buildManagedPluginDependencyStatus>[0],
): Promise<string[]> {
  return buildManagedPluginDependencyStatus(params).missing;
}

export function pluginInstallIncompleteDiagnostic(
  pluginId: string,
  detail: string,
  installId = pluginId,
): PluginDiagnostic {
  const fixHint = `Run \`openclaw plugins install ${installId} --force\` to reinstall the plugin.`;
  return {
    level: "error",
    pluginId,
    code: "plugin-verification",
    message: `Plugin "${pluginId}" install incomplete: ${detail} ${fixHint}`,
    fixHint,
  };
}

/** Projects install failures consistently across cold plugin status surfaces. */
export function projectPluginDependencyHealth<T extends PluginDependencyHealthRegistry>(
  registry: T,
  installTargets: ReadonlyMap<string, string> = new Map(),
): T {
  const diagnostics = [...registry.diagnostics];
  const plugins = registry.plugins.map((plugin) => {
    if (!plugin.enabled) {
      return plugin;
    }
    const dependencyFailure: PluginDiagnostic | undefined =
      plugin.dependencyStatus?.requiredInstalled === false
        ? installTargets.has(plugin.id)
          ? pluginInstallIncompleteDiagnostic(
              plugin.id,
              `required dependencies are missing: ${plugin.dependencyStatus.missing.join(", ")}.`,
              installTargets.get(plugin.id),
            )
          : {
              level: "error" as const,
              pluginId: plugin.id,
              message:
                `Plugin "${plugin.id}" cannot load because required dependencies are missing: ` +
                `${plugin.dependencyStatus.missing.join(", ")}. Install the plugin dependencies or reinstall/update the ` +
                "plugin, then restart the Gateway.",
            }
        : undefined;
    const failure =
      dependencyFailure ??
      diagnostics.find(
        (entry) =>
          entry.level === "error" &&
          entry.pluginId === plugin.id &&
          entry.code === "plugin-verification",
      );
    if (!failure) {
      return plugin;
    }
    const message = failure.message;
    if (dependencyFailure) {
      const existingDiagnosticIndex = diagnostics.findIndex(
        (entry) => entry.level === "error" && entry.pluginId === plugin.id,
      );
      const existingDiagnostic = diagnostics[existingDiagnosticIndex];
      if (!existingDiagnostic) {
        diagnostics.push({ ...failure, source: plugin.source });
      } else {
        diagnostics[existingDiagnosticIndex] = {
          ...failure,
          ...existingDiagnostic,
          fixHint: existingDiagnostic.fixHint ?? failure.fixHint,
          message: existingDiagnostic.message.includes(message)
            ? existingDiagnostic.message
            : `${existingDiagnostic.message}\n${message}`,
        };
      }
    }
    const existingError = plugin.status === "error" ? plugin.error : undefined;
    return {
      ...plugin,
      status: "error" as const,
      error:
        existingError && !existingError.includes(message)
          ? `${existingError}\n${message}`
          : (existingError ?? message),
    };
  });
  return { ...registry, plugins, diagnostics };
}
