import {
  buildModelAliasIndex,
  resolveModelRefFromString,
} from "../../agents/model-selection.js";
import { CONFIG_PATH_CLAWDBOT, loadConfig } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";
import {
  DEFAULT_PROVIDER,
  ensureFlagCompatibility,
  modelKey,
  resolveModelTarget,
  updateConfig,
} from "./shared.js";

export async function modelsImageFallbacksListCommand(
  opts: { json?: boolean; plain?: boolean },
  runtime: RuntimeEnv,
) {
  ensureFlagCompatibility(opts);
  const cfg = loadConfig();
  const fallbacks = cfg.agent?.imageModelFallbacks ?? [];

  if (opts.json) {
    runtime.log(JSON.stringify({ fallbacks }, null, 2));
    return;
  }
  if (opts.plain) {
    for (const entry of fallbacks) runtime.log(entry);
    return;
  }

  runtime.log(`Image fallbacks (${fallbacks.length}):`);
  if (fallbacks.length === 0) {
    runtime.log("- none");
    return;
  }
  for (const entry of fallbacks) runtime.log(`- ${entry}`);
}

export async function modelsImageFallbacksAddCommand(
  modelRaw: string,
  runtime: RuntimeEnv,
) {
  const updated = await updateConfig((cfg) => {
    const resolved = resolveModelTarget({ raw: modelRaw, cfg });
    const targetKey = modelKey(resolved.provider, resolved.model);
    const aliasIndex = buildModelAliasIndex({
      cfg,
      defaultProvider: DEFAULT_PROVIDER,
    });
    const existing = cfg.agent?.imageModelFallbacks ?? [];
    const existingKeys = existing
      .map((entry) =>
        resolveModelRefFromString({
          raw: String(entry ?? ""),
          defaultProvider: DEFAULT_PROVIDER,
          aliasIndex,
        }),
      )
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .map((entry) => modelKey(entry.ref.provider, entry.ref.model));

    if (existingKeys.includes(targetKey)) return cfg;

    return {
      ...cfg,
      agent: {
        ...cfg.agent,
        imageModelFallbacks: [...existing, targetKey],
      },
    };
  });

  runtime.log(`Updated ${CONFIG_PATH_CLAWDBOT}`);
  runtime.log(
    `Image fallbacks: ${(updated.agent?.imageModelFallbacks ?? []).join(", ")}`,
  );
}

export async function modelsImageFallbacksRemoveCommand(
  modelRaw: string,
  runtime: RuntimeEnv,
) {
  const updated = await updateConfig((cfg) => {
    const resolved = resolveModelTarget({ raw: modelRaw, cfg });
    const targetKey = modelKey(resolved.provider, resolved.model);
    const aliasIndex = buildModelAliasIndex({
      cfg,
      defaultProvider: DEFAULT_PROVIDER,
    });
    const existing = cfg.agent?.imageModelFallbacks ?? [];
    const filtered = existing.filter((entry) => {
      const resolvedEntry = resolveModelRefFromString({
        raw: String(entry ?? ""),
        defaultProvider: DEFAULT_PROVIDER,
        aliasIndex,
      });
      if (!resolvedEntry) return true;
      return (
        modelKey(resolvedEntry.ref.provider, resolvedEntry.ref.model) !==
        targetKey
      );
    });

    if (filtered.length === existing.length) {
      throw new Error(`Image fallback not found: ${targetKey}`);
    }

    return {
      ...cfg,
      agent: {
        ...cfg.agent,
        imageModelFallbacks: filtered,
      },
    };
  });

  runtime.log(`Updated ${CONFIG_PATH_CLAWDBOT}`);
  runtime.log(
    `Image fallbacks: ${(updated.agent?.imageModelFallbacks ?? []).join(", ")}`,
  );
}

export async function modelsImageFallbacksClearCommand(runtime: RuntimeEnv) {
  await updateConfig((cfg) => ({
    ...cfg,
    agent: {
      ...cfg.agent,
      imageModelFallbacks: [],
    },
  }));

  runtime.log(`Updated ${CONFIG_PATH_CLAWDBOT}`);
  runtime.log("Image fallback list cleared.");
}
