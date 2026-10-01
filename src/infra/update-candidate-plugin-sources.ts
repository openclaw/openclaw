import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "../plugins/config-state.js";
import type { PluginCandidate } from "../plugins/discovery.js";
import { resolvePluginDoctorContractArtifact } from "../plugins/doctor-contract-artifact.js";
import { loadPluginManifest } from "../plugins/manifest.js";
import { inspectPluginSourceDependencies } from "../plugins/plugin-generation-source-inspection.js";
import { UPDATE_RUN_DIAGNOSTIC_LIMIT, UPDATE_RUN_TEXT_LIMIT } from "./update-run-limits.js";

/** Optional source inspection must not turn a plugin syntax error into an update refusal. */
export function inspectUpdateCandidatePluginSource(
  entry: { pluginId: string; rootDir: string; entryFile: string },
  warnings: string[],
) {
  try {
    return inspectPluginSourceDependencies([entry]);
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    if (warnings.length < UPDATE_RUN_DIAGNOSTIC_LIMIT) {
      warnings.push(
        `Update checks could not inspect plugin ${entry.pluginId} (${entry.entryFile}): ${error.message}. Continuing without dependency inspection for this entry.`.slice(
          0,
          UPDATE_RUN_TEXT_LIMIT,
        ),
      );
    }
    return undefined;
  }
}

/** Snapshot the executable surfaces their owners can demand during candidate validation. */
export function resolveUpdateCandidatePluginSourceEntries(
  candidates: readonly PluginCandidate[],
  config: OpenClawConfig,
) {
  const plugins = normalizePluginsConfig(config.plugins);
  const entries = new Map<string, { pluginId: string; rootDir: string; entryFile: string }>();
  for (const candidate of candidates) {
    if (candidate.format === "bundle") {
      continue;
    }
    const manifest = loadPluginManifest(candidate.rootDir);
    const pluginId =
      candidate.effectivePluginId ?? (manifest.ok ? manifest.manifest.id : candidate.idHint);
    const enabled = resolveEffectiveEnableState({
      id: pluginId,
      origin: candidate.origin,
      config: plugins,
      rootConfig: config,
    }).enabled;
    const packageManifest = candidate.packageManifest;
    if (enabled) {
      entries.set(candidate.source, {
        pluginId,
        rootDir: candidate.rootDir,
        entryFile: candidate.source,
      });
    }
    if (candidate.setupSource && (enabled || packageManifest?.setupFeatures?.configPromotion)) {
      entries.set(candidate.setupSource, {
        pluginId,
        rootDir: candidate.rootDir,
        entryFile: candidate.setupSource,
      });
    }
    if (
      !manifest.ok ||
      (manifest.manifest.doctorContract &&
        !Object.values(manifest.manifest.doctorContract).some(Boolean))
    ) {
      continue;
    }
    // Doctor deliberately considers declared repair surfaces of disabled plugins too.
    const doctor = resolvePluginDoctorContractArtifact({
      rootDir: candidate.rootDir,
      origin: candidate.origin,
      packageManifest,
    });
    if (doctor) {
      entries.set(doctor.modulePath, {
        pluginId,
        rootDir: doctor.boundaryRoot,
        entryFile: doctor.modulePath,
      });
    }
  }
  return [...entries.values()];
}
