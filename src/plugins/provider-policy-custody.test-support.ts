import fs from "node:fs";
import path from "node:path";
import { withEnvAsync } from "../test-utils/env.js";
import { withPluginMetadataSnapshotScope } from "./current-plugin-metadata-snapshot.js";
import { loadPluginManifest } from "./manifest.js";
import { withPluginGenerationSourceCustody } from "./plugin-generation-source-lookup.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";

/** Doctor reads model identity under source custody; an official npm provider owns that policy. */
export async function withInstalledOfficialProviderCustody<T>(
  root: string,
  run: (snapshot: PluginMetadataSnapshot) => Promise<T>,
): Promise<T> {
  const bundled = path.join(root, "bundled");
  const pluginRoot = path.join(root, "installed", "arcee");
  fs.mkdirSync(bundled, { recursive: true });
  fs.mkdirSync(pluginRoot, { recursive: true });
  for (const file of ["provider-policy-api.ts", "package.json", "openclaw.plugin.json"]) {
    fs.copyFileSync(
      path.join(process.cwd(), "extensions", "arcee", file),
      path.join(pluginRoot, file),
    );
  }
  const loaded = loadPluginManifest(pluginRoot);
  if (!loaded.ok) {
    throw new Error(loaded.error);
  }
  const snapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "arcee",
        origin: "global",
        rootDir: pluginRoot,
        providers: ["arcee"],
        providerAuthAliases: loaded.manifest.providerAuthAliases,
        trustedOfficialInstall: true,
      },
    ],
  });
  return await withEnvAsync(
    { OPENCLAW_BUNDLED_PLUGINS_DIR: bundled, OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1" },
    () =>
      withPluginMetadataSnapshotScope(snapshot, () =>
        withPluginGenerationSourceCustody(() => run(snapshot)),
      ),
  );
}
