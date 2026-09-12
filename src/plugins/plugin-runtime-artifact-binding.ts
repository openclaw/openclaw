/** Binds selected artifacts and completed registration to their loaded runtime record. */
import type { OpenClawPackageManifest } from "./manifest.js";
import {
  resolvePluginRuntimeArtifactSelection,
  resolvePluginRuntimeExecutionArtifact,
  type PluginRuntimeArtifact,
} from "./plugin-runtime-artifact-selection.js";
import type { PluginRecord } from "./registry-types.js";

const RUNTIME_ARTIFACT_SELECTION = Symbol.for("openclaw.pluginRuntimeArtifactSelection");
type RuntimeArtifactSelection = {
  sourcePreferred: boolean;
  sourceExternal: boolean;
  runtimeEntry: PluginRuntimeArtifact;
  setupEntry?: PluginRuntimeArtifact;
  preferBuiltPluginArtifacts?: boolean;
  runtimeRegistrationComplete: boolean;
};
type ArtifactBoundRecord = PluginRecord & {
  [RUNTIME_ARTIFACT_SELECTION]?: RuntimeArtifactSelection;
};

type RuntimeArtifactSelectionInput = {
  sourcePreferred?: boolean;
  setupSource?: string;
  packageManifest?: OpenClawPackageManifest;
  preferBuiltPluginArtifacts?: boolean;
};

/** Preserve selection inputs on the loaded owner, outside status/protocol serialization. */
export function bindPluginRuntimeArtifactSelection(
  record: PluginRecord,
  params: RuntimeArtifactSelectionInput & {
    runtimeEntry: PluginRuntimeArtifact;
    setupEntry?: PluginRuntimeArtifact;
  },
): RuntimeArtifactSelection {
  const selection = {
    sourcePreferred: params.sourcePreferred === true,
    sourceExternal: params.packageManifest?.build?.bundledDist === false,
    runtimeEntry: params.runtimeEntry,
    setupEntry: params.setupEntry,
    preferBuiltPluginArtifacts: params.preferBuiltPluginArtifacts,
    runtimeRegistrationComplete: false,
  };
  Object.defineProperty(record, RUNTIME_ARTIFACT_SELECTION, { value: selection });
  return selection;
}

export function hasCompletedPluginRuntimeRegistration(record: ArtifactBoundRecord): boolean {
  return (
    record.status === "loaded" &&
    record[RUNTIME_ARTIFACT_SELECTION]?.runtimeRegistrationComplete === true
  );
}

export function getPluginRuntimeEntrySource(record: ArtifactBoundRecord): string | undefined {
  return record[RUNTIME_ARTIFACT_SELECTION]?.runtimeEntry.source;
}

export function matchesPluginRuntimeArtifactSelection(
  record: ArtifactBoundRecord,
  params: RuntimeArtifactSelectionInput & { rootDir: string; source: string },
  preferBuiltPluginArtifacts?: boolean,
): boolean {
  const loaded = record[RUNTIME_ARTIFACT_SELECTION];
  if (
    (loaded?.sourcePreferred === true) !== (params.sourcePreferred === true) ||
    (loaded?.sourceExternal === true) !== (params.packageManifest?.build?.bundledDist === false) ||
    // Bounded reuse keeps an unspecified policy; exact loads compare the full loader key.
    (preferBuiltPluginArtifacts !== undefined &&
      loaded?.preferBuiltPluginArtifacts !== preferBuiltPluginArtifacts)
  ) {
    return false;
  }
  if (!loaded) {
    // Bundle-format records are metadata-only and never select executable artifacts.
    return (
      record.format === "bundle" &&
      record.rootDir === params.rootDir &&
      record.source === params.source
    );
  }
  // Source/build names alone do not prove shared execution. Compare the loader's
  // selected artifacts while retaining the policy that produced this owner.
  const matchesEntry = (
    entry: PluginRuntimeArtifact,
    source: string,
    entryKind: "runtime" | "setup",
  ): boolean => {
    const selected = resolvePluginRuntimeExecutionArtifact(
      resolvePluginRuntimeArtifactSelection({
        ...params,
        source,
        entryKind,
        origin: record.origin,
        preferBuiltPluginArtifacts: loaded.preferBuiltPluginArtifacts === true,
      }),
    );
    return entry.rootDir === selected.rootDir && entry.source === selected.source;
  };
  return (
    matchesEntry(loaded.runtimeEntry, params.source, "runtime") &&
    (!loaded.setupEntry ||
      (params.setupSource !== undefined &&
        matchesEntry(loaded.setupEntry, params.setupSource, "setup")))
  );
}
