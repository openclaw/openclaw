import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "../plugins/config-state.js";
import type { PluginCandidate } from "../plugins/discovery.js";
import { resolvePluginDoctorContractArtifact } from "../plugins/doctor-contract-artifact.js";
import { loadPluginManifest } from "../plugins/manifest.js";
import { inspectPluginSourceDependencies } from "../plugins/plugin-generation-source-inspection.js";
import { inspectPluginSourceDependenciesAsync } from "../plugins/plugin-generation-worker.js";
import { UPDATE_RUN_DIAGNOSTIC_LIMIT, UPDATE_RUN_TEXT_LIMIT } from "./update-run-limits.js";

/** The candidate-state subprocess already isolates this synchronous source inspection. */
export function inspectUpdateCandidatePluginSource(
  entry: { pluginId: string; rootDir: string; entryFile: string },
  warnings: string[],
  dependencyLookupBoundary?: Parameters<typeof inspectPluginSourceDependencies>[1],
) {
  try {
    return inspectPluginSourceDependencies([entry], dependencyLookupBoundary);
  } catch (error) {
    return handleSourceInspectionError(error, entry, warnings);
  }
}

/** Doctor runs on the serving process; source acquisition belongs to its preparation worker. */
export async function inspectUpdateCandidatePluginSourceAsync(
  entry: { pluginId: string; rootDir: string; entryFile: string },
  warnings: string[],
  dependencyLookupBoundary?: Parameters<typeof inspectPluginSourceDependenciesAsync>[1],
) {
  try {
    return await inspectPluginSourceDependenciesAsync([entry], dependencyLookupBoundary);
  } catch (error) {
    return handleSourceInspectionError(error, entry, warnings);
  }
}

function handleSourceInspectionError(
  error: unknown,
  entry: { pluginId: string; entryFile: string },
  warnings: string[],
): undefined {
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
    const addEntry = (entryFile: string, rootDir = candidate.rootDir) => {
      entries.set(entryFile, { pluginId, rootDir, entryFile });
    };
    if (enabled) {
      addEntry(candidate.source);
    }
    if (candidate.setupSource && (enabled || packageManifest?.setupFeatures?.configPromotion)) {
      addEntry(candidate.setupSource);
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
      addEntry(doctor.modulePath, doctor.boundaryRoot);
    }
  }
  return [...entries.values()];
}
