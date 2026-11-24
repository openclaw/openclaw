// Every provider id and catalog model a bundled plugin declares has a name a person would
// recognise, so a sentence or screen never shows an internal id for something OpenClaw ships.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { resolveProviderDisplayName } from "../../agents/provider-display-name.js";
import { loadPluginManifestRegistryCore } from "../manifest-registry.js";
import { buildPluginMetadataProviderFacts } from "../plugin-metadata-provider-facts.js";

const bundledPlugins = loadPluginManifestRegistryCore({
  config: {},
  env: {
    ...process.env,
    OPENCLAW_BUNDLED_PLUGINS_DIR: resolve(process.cwd(), "extensions"),
    OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
  },
}).plugins.filter((plugin) => plugin.origin === "bundled");
const owners = buildPluginMetadataProviderFacts(bundledPlugins);

it("names every provider a bundled plugin declares", () => {
  const unnamed = bundledPlugins.flatMap((plugin) =>
    [
      ...new Set([
        ...plugin.providers,
        ...plugin.cliBackends,
        ...Object.keys(plugin.modelCatalog?.providers ?? {}),
        ...(plugin.contracts?.decisionProviders ?? []),
      ]),
    ]
      .filter((id) => resolveProviderDisplayName(id, { owners }) === id)
      .map((id) => `${plugin.id}: ${id}`),
  );
  expect(
    unnamed,
    'Add each provider id to "providerNames" in the plugin\'s openclaw.plugin.json, with the name a person would recognise.',
  ).toEqual([]);
});

it("names every model row a bundled plugin's catalog declares", () => {
  const unnamed = bundledPlugins.flatMap((plugin) =>
    Object.entries(plugin.modelCatalog?.providers ?? {}).flatMap(([provider, catalog]) =>
      catalog.models
        // Pickers and sentences already name the provider beside the model.
        .filter(
          (model) => !model.name?.trim() || model.name === model.id || / via /i.test(model.name),
        )
        .map((model) => `${plugin.id}: ${provider}/${model.id} (${model.name ?? "no name"})`),
    ),
  );
  expect(
    unnamed,
    'Give each model row a "name" a person would recognise, without its provider ("GPT-6 Luna", not "gpt-6-luna" or "GPT-6 Luna via ClawRouter").',
  ).toEqual([]);
});

it("gives the Control UI the same names before a Gateway catalog loads", () => {
  const generated: unknown = JSON.parse(
    readFileSync(resolve(process.cwd(), "ui/src/components/provider-names.generated.json"), "utf8"),
  );
  expect(generated, "Run pnpm ui:provider-names:gen.").toEqual(
    Object.fromEntries(owners.providerNames),
  );
});

it("prefers the operator's name and leaves an unnamed operator-defined provider as its id", () => {
  const config = {
    models: {
      providers: {
        openrouter: { baseUrl: "https://openrouter.example/v1", models: [], name: "Team router" },
        workstation: { baseUrl: "https://models.example/v1", models: [] },
      },
    },
  };
  expect(resolveProviderDisplayName("openrouter", { owners })).toBe("OpenRouter");
  expect(resolveProviderDisplayName("openrouter", { config, owners })).toBe("Team router");
  expect(resolveProviderDisplayName("workstation", { config, owners })).toBe("workstation");
});
