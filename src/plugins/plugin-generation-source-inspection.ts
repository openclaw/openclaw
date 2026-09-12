import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";

/** Inspect the same source graph the module owner will capture, without evaluating it. */
export function inspectPluginGenerationSources(
  entries: readonly { pluginId: string; rootDir: string; entryFile?: string }[],
) {
  const bySource = new Map<string, string>();
  const digests = new Map<string, string>();
  const checks: Array<() => void> = [];
  for (const entry of entries) {
    if (digests.has(entry.pluginId)) {
      continue;
    }
    const key = `${entry.rootDir}\0${entry.entryFile ?? ""}`;
    let digest = bySource.get(key);
    if (digest === undefined) {
      const artifact = capturePluginGenerationArtifact(entry.rootDir, entry.entryFile);
      try {
        digest = artifact.sourceDigest;
        bySource.set(key, digest);
        checks.push(artifact.assertSourceCurrent);
      } finally {
        artifact.dispose();
      }
    }
    digests.set(entry.pluginId, digest);
  }
  return {
    sourceDigests: Object.fromEntries(digests),
    assertSourceCurrent: () => {
      for (const check of checks) {
        check();
      }
    },
  };
}
