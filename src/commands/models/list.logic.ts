import type { Api, Model } from "@mariozechner/pi-ai";
import type { ModelRow } from "./list.types.js";
import { ensureAuthProfileStore } from "../../agents/auth-profiles.js";
import { parseModelRef } from "../../agents/model-selection.js";
import { loadConfig } from "../../config/config.js";
import { resolveConfiguredEntries } from "./list.configured.js";
import { loadModelRegistry, toModelRow } from "./list.registry.js";
import { DEFAULT_PROVIDER, modelKey } from "./shared.js";

export type ModelsListOptions = {
  all?: boolean;
  local?: boolean;
  provider?: string;
};

export async function modelsListLogic(
  opts: ModelsListOptions,
): Promise<{ rows: ModelRow[]; error?: string }> {
  const cfg = loadConfig();
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
  let availableKeys: Set<string> | undefined;
  let error: string | undefined;

  try {
    const loaded = await loadModelRegistry(cfg);
    models = loaded.models;
    availableKeys = loaded.availableKeys;
  } catch (err) {
    error = `Model registry unavailable: ${String(err)}`;
  }

  const modelByKey = new Map(models.map((model) => [modelKey(model.provider, model.id), model]));

  const { entries } = resolveConfiguredEntries(cfg);
  const configuredByKey = new Map(entries.map((entry) => [entry.key, entry]));

  const rows: ModelRow[] = [];

  const isLocalBaseUrl = (baseUrl: string) => {
    try {
      const url = new URL(baseUrl);
      const host = url.hostname.toLowerCase();
      return (
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "0.0.0.0" ||
        host === "::1" ||
        host.endsWith(".local")
      );
    } catch {
      return false;
    }
  };

  if (opts.all) {
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
    }
  } else {
    for (const entry of entries) {
      if (providerFilter && entry.ref.provider.toLowerCase() !== providerFilter) {
        continue;
      }
      const model = modelByKey.get(entry.key);
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
        }),
      );
    }
  }

  return { rows, error };
}
