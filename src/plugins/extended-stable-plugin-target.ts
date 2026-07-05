// Resolves exact plugin targets for the additive extended-stable channel.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import type { UpdateChannel } from "../infra/update-channels.js";
import {
  loadExtendedStablePluginSupport,
  type ExtendedStablePluginSupport,
} from "./extended-stable-plugin-support.js";
import {
  listOfficialExternalPluginCatalogEntries,
  resolveOfficialExternalPluginInstall,
  type OfficialExternalPluginCatalogEntry,
} from "./official-external-plugin-catalog.js";

export type ExtendedStablePluginTargetCode =
  | "extended_stable_target"
  | "monthly_snapshot_target"
  | "user_pin_preserved";

type ExtendedStablePluginTargetDecision =
  | { kind: "covered"; code: "extended_stable_target"; installSpec: string; recordSpec: string }
  | { kind: "snapshot"; code: "monthly_snapshot_target"; installSpec: string; recordSpec: string }
  | { kind: "preserved"; code: "user_pin_preserved"; installSpec: string; recordSpec: string }
  | { kind: "unchanged"; installSpec: string; recordSpec: string };

export type ExtendedStablePluginTargetContext = {
  installedCoreVersion: string;
  snapshotVersion: string;
  support: ExtendedStablePluginSupport;
  snapshotPackageNames: ReadonlySet<string>;
};

const FINAL_CALENDAR_VERSION_RE = /^(?<year>\d{4})\.(?<month>[1-9]|1[0-2])\.(?<patch>0|[1-9]\d*)$/u;

export function resolveExtendedStableSnapshotVersion(coreVersion: string): string {
  const match = FINAL_CALENDAR_VERSION_RE.exec(coreVersion)?.groups;
  const patch = match ? Number.parseInt(match.patch, 10) : Number.NaN;
  if (!match || !Number.isSafeInteger(patch) || patch < 33) {
    throw new Error(
      `extended-stable core version ${coreVersion} must be a final YYYY.M.PATCH with PATCH >= 33`,
    );
  }
  return `${match.year}.${match.month}.33`;
}

export function loadExtendedStablePluginTargetContext(params: {
  rootDir: string;
  installedCoreVersion: string;
}): ExtendedStablePluginTargetContext {
  const support = loadExtendedStablePluginSupport(params.rootDir);
  const snapshotVersion = resolveExtendedStableSnapshotVersion(params.installedCoreVersion);
  return {
    installedCoreVersion: params.installedCoreVersion,
    snapshotVersion,
    support,
    snapshotPackageNames: resolveExtendedStableSnapshotPackageNames({ support }),
  };
}

export function loadExtendedStablePluginTargetContextFromRoot(params: {
  rootDir: string;
  expectedCoreVersion?: string;
}): ExtendedStablePluginTargetContext {
  let packageJson: { name?: unknown; version?: unknown };
  try {
    packageJson = JSON.parse(readFileSync(join(params.rootDir, "package.json"), "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
  } catch (error) {
    throw new Error(`Could not read installed core package version: ${String(error)}`, {
      cause: error,
    });
  }
  const packageName = typeof packageJson.name === "string" ? packageJson.name : "";
  if (packageName !== "openclaw" && !/^@[^/]+\/openclaw$/u.test(packageName)) {
    throw new Error("Installed core package identity must be openclaw or a scoped openclaw fork.");
  }
  const version = packageJson.version;
  if (typeof version !== "string" || !version.trim()) {
    throw new Error("Installed core package version is missing.");
  }
  if (params.expectedCoreVersion && version !== params.expectedCoreVersion) {
    throw new Error(
      `Installed core package version ${version} does not match expected ${params.expectedCoreVersion}.`,
    );
  }
  return loadExtendedStablePluginTargetContext({
    rootDir: params.rootDir,
    installedCoreVersion: version,
  });
}

function isDefaultIntent(spec: string): { packageName: string } | null {
  const parsed = parseRegistryNpmSpec(spec);
  if (!parsed) {
    return null;
  }
  if (parsed.selectorKind === "none") {
    return { packageName: parsed.name };
  }
  if (parsed.selectorKind === "tag" && parsed.selector?.toLowerCase() === "latest") {
    return { packageName: parsed.name };
  }
  return null;
}

export function resolveExtendedStableSnapshotPackageNames(params: {
  support: ExtendedStablePluginSupport;
  entries?: readonly OfficialExternalPluginCatalogEntry[];
}): Set<string> {
  const covered = new Set(params.support.plugins.map((entry) => entry.packageName));
  const packageNames = new Set<string>();
  for (const entry of params.entries ?? listOfficialExternalPluginCatalogEntries()) {
    if (entry.source !== "official") {
      continue;
    }
    const npmSpec = resolveOfficialExternalPluginInstall(entry)?.npmSpec;
    const packageName = npmSpec ? parseRegistryNpmSpec(npmSpec)?.name : undefined;
    if (packageName && !covered.has(packageName)) {
      packageNames.add(packageName);
    }
  }
  return packageNames;
}

export function resolveExtendedStablePluginTarget(params: {
  requestedSpec: string;
  officialPackageName?: string;
  updateChannel?: UpdateChannel;
  installedCoreVersion?: string;
  snapshotVersion?: string;
  support?: ExtendedStablePluginSupport;
  snapshotPackageNames?: ReadonlySet<string>;
}): ExtendedStablePluginTargetDecision {
  const unchanged = {
    kind: "unchanged",
    installSpec: params.requestedSpec,
    recordSpec: params.requestedSpec,
  } as const;
  if (params.updateChannel !== "extended-stable") {
    return unchanged;
  }
  const parsed = parseRegistryNpmSpec(params.requestedSpec);
  if (!parsed || !params.officialPackageName || parsed.name !== params.officialPackageName) {
    return unchanged;
  }
  const defaultIntent = isDefaultIntent(params.requestedSpec);
  if (!defaultIntent) {
    return {
      kind: "preserved",
      code: "user_pin_preserved",
      installSpec: params.requestedSpec,
      recordSpec: params.requestedSpec,
    };
  }
  const covered = params.support?.plugins.some(
    (entry) => entry.packageName === params.officialPackageName,
  );
  if (covered) {
    if (!params.installedCoreVersion) {
      throw new Error("extended-stable covered plugin targeting requires installed core version");
    }
    resolveExtendedStableSnapshotVersion(params.installedCoreVersion);
    return {
      kind: "covered",
      code: "extended_stable_target",
      installSpec: `${defaultIntent.packageName}@${params.installedCoreVersion}`,
      recordSpec: params.requestedSpec,
    };
  }
  if (params.snapshotPackageNames?.has(params.officialPackageName)) {
    if (!params.installedCoreVersion) {
      throw new Error("extended-stable snapshot plugin targeting requires installed core version");
    }
    const snapshotVersion = resolveExtendedStableSnapshotVersion(params.installedCoreVersion);
    if (params.snapshotVersion && params.snapshotVersion !== snapshotVersion) {
      throw new Error(
        `extended-stable snapshot version ${params.snapshotVersion} does not match installed core ${params.installedCoreVersion}`,
      );
    }
    return {
      kind: "snapshot",
      code: "monthly_snapshot_target",
      installSpec: `${defaultIntent.packageName}@${snapshotVersion}`,
      recordSpec: params.requestedSpec,
    };
  }
  return unchanged;
}
