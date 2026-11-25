// Inspect authored manifests: invalid rows must not disappear before the naming check.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { loadPluginManifestRegistryCore } from "../manifest-registry.js";
import { loadPluginManifest, type PluginManifest } from "../manifest.js";
import { buildPluginMetadataProviderFacts } from "../plugin-metadata-provider-facts.js";

const extensions = resolve(process.cwd(), "extensions");
const manifests = readdirSync(extensions, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(extensions, entry.name))
  .filter((root) => existsSync(join(root, "openclaw.plugin.json")))
  .map((root) => ({
    root,
    manifest: JSON.parse(
      readFileSync(join(root, "openclaw.plugin.json"), "utf8"),
    ) as PluginManifest,
  }));

it("admits every authored manifest before checking provider names", () => {
  expect(manifests.length).toBeGreaterThan(0);
  for (const { root } of manifests) {
    expect(loadPluginManifest(root), root).toMatchObject({ ok: true });
  }
});

it("names every provider a bundled plugin declares", () => {
  const unnamed = manifests.flatMap(({ manifest }) =>
    [
      ...new Set([
        ...(manifest.providers ?? []),
        ...(manifest.cliBackends ?? []),
        ...Object.keys(manifest.modelCatalog?.providers ?? {}),
        ...(manifest.contracts?.decisionProviders ?? []),
      ]),
    ]
      .filter(
        (id) => !manifest.providerNames?.[id]?.trim() || manifest.providerNames[id].trim() === id,
      )
      .map((id) => manifest.id + ": " + id),
  );
  expect(unnamed, 'Add readable names to the owning manifest "providerNames".').toEqual([]);
});

it("names every authored model without repeating the routing provider", () => {
  const unnamed = manifests.flatMap(({ manifest }) =>
    Object.entries(manifest.modelCatalog?.providers ?? {}).flatMap(([provider, catalog]) =>
      catalog.models
        .filter(
          (model) =>
            !model.name?.trim() || model.name.trim() === model.id || / via /i.test(model.name),
        )
        .map((model) => manifest.id + ": " + provider + "/" + model.id),
    ),
  );
  expect(unnamed, 'Give each model a readable "name", without "via <provider>".').toEqual([]);
});

it("keeps shared cold-start names identical to loaded manifest names", () => {
  const plugins = loadPluginManifestRegistryCore({
    config: {},
    env: {
      ...process.env,
      OPENCLAW_BUNDLED_PLUGINS_DIR: extensions,
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
    },
  }).plugins.filter((plugin) => plugin.origin === "bundled");
  const owners = buildPluginMetadataProviderFacts(plugins);
  const generated: unknown = JSON.parse(
    readFileSync(resolve(process.cwd(), "src/shared/provider-names.generated.json"), "utf8"),
  );
  expect(generated, "Run pnpm providers:names:gen.").toEqual(
    Object.fromEntries(owners.providerNames),
  );
});
