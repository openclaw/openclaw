import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

type PluginManifest = {
  optionalDependencies?: Record<string, string>;
  openclaw?: { release?: { publishToNpm?: unknown; bundleRuntimeDependencies?: unknown } };
};

// Bundling the runtime closure packs only the optional variants installed on the
// release host, so every other platform loses its native binding (#203211).
it("leaves direct optional dependencies to npm for published plugin packages", () => {
  const bundled = readdirSync("extensions").filter((id) => {
    const manifestPath = join("extensions", id, "package.json");
    if (!existsSync(manifestPath)) {
      return false;
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PluginManifest;
    const release = manifest.openclaw?.release;
    return (
      release?.publishToNpm === true &&
      Object.keys(manifest.optionalDependencies ?? {}).length > 0 &&
      release.bundleRuntimeDependencies !== false
    );
  });
  expect(bundled).toEqual([]);
});
