import type { Api, Model } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { loadModelCatalog } from "../../agents/model-catalog.js";
import { parseModelRef } from "../../agents/model-selection.js";
import { resolveModelWithRegistry } from "../../agents/pi-embedded-runner/model.js";
import type { RuntimeEnv } from "../../runtime.js";
import { resolveConfiguredEntries } from "./list.configured.js";
import { formatErrorWithStack } from "./list.errors.js";
import { loadModelRegistry, toModelRow } from "./list.registry.js";
import { printModelTable } from "./list.table.js";
import type { ModelRow } from "./list.types.js";
import { loadModelsConfigWithSource } from "./load-config.js";
import { DEFAULT_PROVIDER, ensureFlagCompatibility, isLocalBaseUrl, modelKey } from "./shared.js";

export async function modelsListCommand(
  opts: {
    all?: boolean;
    local?: boolean;
    provider?: string;
    json?: boolean;
    plain?: boolean;
  },
  runtime: RuntimeEnv,
) {
  ensureFlagCompatibility(opts);
  const { ensureAuthProfileStore } = await import("../../agents/auth-profiles.js");
  const { sourceConfig, resolvedConfig: cfg } = await loadModelsConfigWithSource({
    commandName: "models list",
    runtime,
  });
  const authStore = ensureAuthProfileStore();
  const providerFilter = (() => {
    const raw = opts.provider?.trim();
    if (!raw) {
      return undefined;
    }
    const parsed = parseModelRef(`${raw}/_`, DEFAULT_PROVIDER);
    return parsed?.provider ?? raw.toLowerCase();
  })();

  let models: Model<Api>[] = [];
  let modelRegistry: ModelRegistry | undefined;
  let availableKeys: Set<string> | undefined;
  let availabilityErrorMessage: string | undefined;
  try {
    const loaded = await loadModelRegistry(cfg, { sourceConfig });
    modelRegistry = loaded.registry;
    models = loaded.models;
    availableKeys = loaded.availableKeys;
    availabilityErrorMessage = loaded.availabilityErrorMessage;
  } catch (err) {
    runtime.error(`Model registry unavailable:\n${formatErrorWithStack(err)}`);
    process.exitCode = 1;
    return;
  }
  if (availabilityErrorMessage !== undefined) {
    runtime.error(
      `Model availability lookup failed; falling back to auth heuristics for discovered models: ${availabilityErrorMessage}`,
    );
  }
  const discoveredKeys = new Set(models.map((model) => modelKey(model.provider, model.id)));

  const { entries } = resolveConfiguredEntries(cfg);
  const configuredByKey = new Map(entries.map((entry) => [entry.key, entry]));

  const rows: ModelRow[] = [];

  if (opts.all) {
    const seenKeys = new Set<string>();
    const sorted = [...models].toSorted((a, b) => {
      const p = a.provider.localeCompare(b.provider);
      if (p !== 0) {
        return p;
      }
      return a.id.localeCompare(b.id);
    });

    for (const model of sorted) {
      if (providerFilter && model.provider.toLowerCase() !== providerFilter) {
        continue;
      }
      if (opts.local && !isLocalBaseUrl(model.baseUrl)) {
        continue;
      }
      const key = modelKey(model.provider, model.id);
      const configured = configuredByKey.get(key);
      rows.push(
        toModelRow({
          model,
          key,
          tags: configured ? Array.from(configured.tags) : [],
          aliases: configured?.aliases ?? [],
          availableKeys,
          cfg,
          authStore,
        }),
      );
      seenKeys.add(key);
    }

    if (modelRegistry) {
      const catalog = await loadModelCatalog({ config: cfg });
      for (const entry of catalog) {
        if (providerFilter && entry.provider.toLowerCase() !== providerFilter) {
          continue;
        }
        const key = modelKey(entry.provider, entry.id);
        if (seenKeys.has(key)) {
          continue;
        }
        const model = resolveModelWithRegistry({
          provider: entry.provider,
          modelId: entry.id,
          modelRegistry,
          cfg,
        });
        if (!model) {
          continue;
        }
        if (opts.local && !isLocalBaseUrl(model.baseUrl)) {
          continue;
        }
        const configured = configuredByKey.get(key);
        rows.push(
          toModelRow({
            model,
            key,
            tags: configured ? Array.from(configured.tags) : [],
            aliases: configured?.aliases ?? [],
            availableKeys,
            cfg,
            authStore,
            allowProviderAvailabilityFallback: !discoveredKeys.has(key),
          }),
        );
        seenKeys.add(key);
      }
    }
  } else {
    const registry = modelRegistry;
    if (!registry) {
      runtime.error("Model registry unavailable.");
      process.exitCode = 1;
      return;
    }
    for (const entry of entries) {
      if (providerFilter && entry.ref.provider.toLowerCase() !== providerFilter) {
        continue;
      }
      const model = resolveModelWithRegistry({
        provider: entry.ref.provider,
        modelId: entry.ref.model,
        modelRegistry: registry,
        cfg,
      });
      if (opts.local && model && !isLocalBaseUrl(model.baseUrl)) {
        continue;
      }
      if (opts.local && !model) {
        continue;
      }
      rows.push(
        toModelRow({
          model,
          key: entry.key,
          tags: Array.from(entry.tags),
          aliases: entry.aliases,
          availableKeys,
          cfg,
          authStore,
          allowProviderAvailabilityFallback: model
            ? !discoveredKeys.has(modelKey(model.provider, model.id))
            : false,
        }),
      );
    }
  }

  if (rows.length === 0) {
    runtime.log("No models found.");
    return;
  }

  printModelTable(rows, runtime, opts);
}
