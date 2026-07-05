// Resolves exact plugin targets for the additive extended-stable channel.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import type { UpdateChannel } from "../infra/update-channels.js";
import {
  loadExtendedStablePluginCohort,
  type ExtendedStablePluginCohort,
} from "./extended-stable-plugin-cohort.js";
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
  | "monthly_cohort_target"
  | "user_pin_preserved";

type ExtendedStablePluginTargetDecision =
  | { kind: "covered"; code: "extended_stable_target"; installSpec: string; recordSpec: string }
  | { kind: "cohort"; code: "monthly_cohort_target"; installSpec: string; recordSpec: string }
  | { kind: "preserved"; code: "user_pin_preserved"; installSpec: string; recordSpec: string }
  | { kind: "unchanged"; installSpec: string; recordSpec: string };

export type ExtendedStablePluginTargetContext = {
  installedCoreVersion: string;
  support: ExtendedStablePluginSupport;
  cohort: ExtendedStablePluginCohort;
  cohortPackageNames: ReadonlySet<string>;
};

export function loadExtendedStablePluginTargetContext(params: {
  rootDir: string;
  installedCoreVersion: string;
}): ExtendedStablePluginTargetContext {
  const support = loadExtendedStablePluginSupport(params.rootDir);
  const cohort = loadExtendedStablePluginCohort(params.rootDir);
  const releaseLine = params.installedCoreVersion.split(".").slice(0, 2).join(".");
  if (cohort.releaseLine !== releaseLine) {
    throw new Error(
      `cohort releaseLine ${cohort.releaseLine} does not match installed core ${params.installedCoreVersion}`,
    );
  }
  return {
    installedCoreVersion: params.installedCoreVersion,
    support,
    cohort,
    cohortPackageNames: resolveExtendedStableCohortPackageNames({ support }),
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
  if (packageJson.name !== "openclaw") {
    throw new Error("Installed core package identity must be openclaw.");
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

export function resolveExtendedStableCohortPackageNames(params: {
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
  support?: ExtendedStablePluginSupport;
  cohort?: ExtendedStablePluginCohort;
  cohortPackageNames?: ReadonlySet<string>;
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
    return {
      kind: "covered",
      code: "extended_stable_target",
      installSpec: `${defaultIntent.packageName}@${params.installedCoreVersion}`,
      recordSpec: params.requestedSpec,
    };
  }
  if (params.cohortPackageNames?.has(params.officialPackageName)) {
    if (!params.cohort) {
      throw new Error("extended-stable cohort plugin targeting requires cohort metadata");
    }
    return {
      kind: "cohort",
      code: "monthly_cohort_target",
      installSpec: `${defaultIntent.packageName}@${params.cohort.baselineVersion}`,
      recordSpec: params.requestedSpec,
    };
  }
  return unchanged;
}
