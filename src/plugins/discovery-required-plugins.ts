// Emits missing-plugin warnings without changing declared plugin identities.
import type { PluginDiscoveryResult } from "./discovery.types.js";
import { shouldRejectHardlinkedPluginFiles } from "./hardlink-policy.js";
import { loadPluginManifest } from "./manifest.js";
import { normalizePluginPolicyId } from "./plugin-policy-id.js";

export function addMissingRequiredPluginDiagnostics(
  result: PluginDiscoveryResult,
  params: { env: NodeJS.ProcessEnv },
): void {
  const candidatePolicyIds = new Set(
    result.candidates.map((candidate) => normalizePluginPolicyId(candidate.idHint)),
  );
  const seen = new Set<string>();
  let configuredFileManifestPolicyIds: Set<string> | undefined;
  for (const candidate of result.candidates) {
    for (const requiredPluginId of candidate.requiredPluginIds ?? []) {
      const requiredPolicyId = normalizePluginPolicyId(requiredPluginId);
      if (candidatePolicyIds.has(requiredPolicyId)) {
        continue;
      }
      if (!configuredFileManifestPolicyIds) {
        configuredFileManifestPolicyIds = new Set();
        // Explicit files keep filename hints; only a validated root manifest
        // can establish their canonical identity for a missing dependency.
        for (const configuredCandidate of result.candidates) {
          if (configuredCandidate.origin !== "config" || configuredCandidate.packageDir) {
            continue;
          }
          const rejectHardlinks = shouldRejectHardlinkedPluginFiles({
            origin: configuredCandidate.origin,
            rootDir: configuredCandidate.rootDir,
            env: params.env,
          });
          const manifest = loadPluginManifest(configuredCandidate.rootDir, rejectHardlinks);
          if (manifest.ok) {
            configuredFileManifestPolicyIds.add(normalizePluginPolicyId(manifest.manifest.id));
          }
        }
      }
      if (configuredFileManifestPolicyIds.has(requiredPolicyId)) {
        continue;
      }
      const key = `${normalizePluginPolicyId(candidate.idHint)}\0${requiredPolicyId}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.diagnostics.push({
        level: "warn",
        pluginId: candidate.idHint,
        source: candidate.requiredPluginSource ?? candidate.source,
        message: `plugin "${candidate.idHint}" requires plugin "${requiredPluginId}"; install "${requiredPluginId}" to use it`,
      });
    }
  }
}
