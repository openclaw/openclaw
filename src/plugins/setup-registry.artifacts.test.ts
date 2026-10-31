import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { PluginManifestRegistry } from "./manifest-registry.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { createPluginManifestRecordFixture } from "./plugin-metadata.test-support.js";
import { writeArtifact } from "./public-surface.test-support.js";
import { resolvePluginSetupRegistry } from "./setup-registry.js";
import type { ProviderPlugin } from "./types.js";

const temp = useAutoCleanupTempDirTracker(afterEach);

function setupManifest(
  id: string,
  rootDir: string,
  source: string,
  options: Partial<PluginManifestRegistry["plugins"][number]>,
): PluginManifestRegistry {
  const plugin = createPluginManifestRecordFixture({
    id,
    rootDir,
    source,
    origin: "global",
    providers: [id],
    setup: { requiresRuntime: true, providers: [{ id }] },
    ...options,
  });
  return { plugins: [plugin], diagnostics: [] };
}

it.each(["cjs", "mjs"])("reuses bundled %s setup", async (extension) => {
  const rootDir = temp.make("bundled-setup-identity-");
  const source = path.join(rootDir, `setup-api.${extension}`);
  const manifestRegistry = setupManifest("bundled-owner", rootDir, source, {
    origin: "bundled",
    setupSource: source,
  });
  writeArtifact(
    source,
    `let registrations = 0;
        ${extension === "mjs" ? "export default" : "module.exports ="} {
        register(api) {
          const registration = ++registrations;
          api.registerProvider({ id: "bundled-owner", resolveConfigApiKey: () => String(registration) });
        }
      };`,
  );
  const caches = Array.from({ length: 3 }, () => createPluginCache());
  const query = { provider: "bundled-owner", env: {} };
  try {
    let previous: ProviderPlugin | undefined;
    for (const [index, cache] of caches.entries()) {
      const result = withPluginCache(cache, () => resolvePluginSetupRegistry({ manifestRegistry }));
      expect(result).toMatchObject({ diagnostics: [], providers: [expect.anything()] });
      const current = result.providers[0]!.provider;
      if (index > 0) {
        await retirePluginCache(caches[index - 1]!);
        expect(() => previous!.resolveConfigApiKey?.(query)).toThrow(/reloaded|disabled|retir/);
      }
      expect(current.resolveConfigApiKey?.(query)).toBe(String(index + 1));
      previous = current;
    }
  } finally {
    await Promise.all(caches.map((cache) => retirePluginCache(cache)));
  }
});
describe("installed setup artifacts", () => {
  afterEach(clearPluginMetadataLifecycleCaches);

  it.each([
    [".", true, "cjs", undefined],
    ["dist", false, "cjs", undefined],
    [".", false, "mjs", "setup-api.ts"],
    [".", false, "ts", "setup-api.js"],
  ] as const)(
    "reloads %s artifacts (declared=%s, extension=%s, dist conflict=%s)",
    (artifactDir, declared, extension, competingDist) => {
      const rootDir = temp.make("openclaw-setup-lifecycle-");
      const artifactRoot = path.join(rootDir, artifactDir);
      const setupSource = path.join(artifactRoot, `setup-api.${extension}`);
      const dependencyPath = path.join(artifactRoot, "setup-dependency.cjs");
      if (competingDist) {
        writeArtifact(
          path.join(rootDir, "dist", competingDist),
          'module.exports = { register(api) { api.registerProvider({ id: "setup-lifecycle", label: "wrong-dist-entry" }); } };\n',
        );
      }
      const writeSetupArtifact = (version: string) => {
        writeArtifact(dependencyPath, `module.exports = "dependency-${version}";\n`);
        writeArtifact(
          setupSource,
          `${extension === "mjs" ? 'import dependency from "./setup-dependency.cjs"; export default' : "module.exports ="}
          { register(api) { api.registerProvider({ id: "setup-lifecycle", label: "entry-${version}:" + ${extension === "mjs" ? "dependency" : 'require("./setup-dependency.cjs")'} }); } };\n`,
        );
      };
      const manifestRegistry = setupManifest(
        "setup-lifecycle",
        rootDir,
        setupSource,
        declared ? { setupSource } : {},
      );

      for (const version of ["before", "after"]) {
        writeSetupArtifact(version);
        if (version === "after") {
          clearPluginMetadataLifecycleCaches();
        }
        expect(resolvePluginSetupRegistry({ manifestRegistry }).providers[0]?.provider.label).toBe(
          `entry-${version}:dependency-${version}`,
        );
      }
    },
  );
});
