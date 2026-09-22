import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "../plugins/config-state.js";
import type { PluginCandidate } from "../plugins/discovery.js";
import { resolvePluginDoctorContractArtifact } from "../plugins/doctor-contract-artifact.js";
import { loadPluginManifest } from "../plugins/manifest.js";

/** Snapshot the executable surfaces their owners can demand during candidate validation. */
export function resolveUpdateCandidatePluginSourceEntries(
  candidates: readonly PluginCandidate[],
  config: OpenClawConfig,
) {
  const plugins = normalizePluginsConfig(config.plugins);
  const entries = new Map<string, { rootDir: string; entryFile: string }>();
  for (const candidate of candidates) {
    if (candidate.format === "bundle") {
      continue;
    }
    const manifest = loadPluginManifest(candidate.rootDir);
    const enabled = resolveEffectiveEnableState({
      id: candidate.effectivePluginId ?? (manifest.ok ? manifest.manifest.id : candidate.idHint),
      origin: candidate.origin,
      config: plugins,
      rootConfig: config,
    }).enabled;
    const packageManifest = candidate.packageManifest;
    if (enabled) {
      entries.set(candidate.source, { rootDir: candidate.rootDir, entryFile: candidate.source });
    }
    if (candidate.setupSource && (enabled || packageManifest?.setupFeatures?.configPromotion)) {
      entries.set(candidate.setupSource, {
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
        rootDir: doctor.boundaryRoot,
        entryFile: doctor.modulePath,
      });
    }
  }
  return [...entries.values()];
}
