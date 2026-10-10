import { formatCliCommand } from "../../cli/command-format.js";
import { logConfigUpdated } from "../../config/logging.js";
import { resolveAgentModelFallbackValues, toAgentModelListLike } from "../../config/model-input.js";
import type { AgentModelEntryConfig } from "../../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { type RuntimeEnv, writeRuntimeJson, writeRuntimeStdout } from "../../runtime.js";
import { loadModelsConfig } from "./load-config.js";
import {
  ensureFlagCompatibility,
  mergePrimaryFallbackConfig,
  modelKey,
  resolveModelTarget,
  resolveModelRefsFromEntries,
  upsertCanonicalModelConfigEntry,
  updateConfig,
} from "./shared.js";

type DefaultsFallbackKey = "model" | "imageModel";

function listCommandForFallbackKey(key: DefaultsFallbackKey): string {
  return key === "imageModel" ? "models image-fallbacks list" : "models fallbacks list";
}

function getFallbacks(cfg: OpenClawConfig, key: DefaultsFallbackKey): string[] {
  return resolveAgentModelFallbackValues(cfg.agents?.defaults?.[key]);
}

function patchDefaultsFallbacks(
  cfg: OpenClawConfig,
  params: {
    key: DefaultsFallbackKey;
    fallbacks: string[];
    models?: Record<string, AgentModelEntryConfig>;
  },
): OpenClawConfig {
  const existing = toAgentModelListLike(cfg.agents?.defaults?.[params.key]);
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        [params.key]: mergePrimaryFallbackConfig(existing, { fallbacks: params.fallbacks }),
        ...(params.models ? { models: params.models } : undefined),
      },
    },
  };
}

export async function listFallbacksCommand(
  params: { label: string; key: DefaultsFallbackKey },
  opts: { json?: boolean; plain?: boolean },
  runtime: RuntimeEnv,
) {
  ensureFlagCompatibility(opts);
  const cfg = await loadModelsConfig({
    commandName: listCommandForFallbackKey(params.key),
    runtime,
  });
  const fallbacks = getFallbacks(cfg, params.key);

  if (opts.json) {
    writeRuntimeJson(runtime, { fallbacks });
    return;
  }
  if (opts.plain) {
    for (const entry of fallbacks) {
      writeRuntimeStdout(runtime, entry);
    }
    return;
  }

  runtime.log(`${params.label} (${fallbacks.length}):`);
  if (fallbacks.length === 0) {
    runtime.log("- none");
    return;
  }
  for (const entry of fallbacks) {
    runtime.log(`- ${entry}`);
  }
}

export async function changeFallbacksCommand(
  params: {
    label: string;
    key: DefaultsFallbackKey;
  } & ({ action: "add" } | { action: "remove"; notFoundLabel: string }),
  modelRaw: string,
  runtime: RuntimeEnv,
) {
  const updated = await updateConfig(
    (cfg, context) => {
      const { runtimeConfig } = context;
      const resolved = resolveModelTarget({ raw: modelRaw, cfg: runtimeConfig });
      const nextModels = params.action === "add" ? { ...cfg.agents?.defaults?.models } : undefined;
      const targetKey = nextModels
        ? upsertCanonicalModelConfigEntry(nextModels, resolved, context)
        : modelKey(resolved.provider, resolved.model);
      const existing = getFallbacks(cfg, params.key);
      const existingKeys = resolveModelRefsFromEntries({
        cfg: runtimeConfig,
        entries: getFallbacks(runtimeConfig, params.key),
      }).map((ref) => (ref ? modelKey(ref.provider, ref.model) : undefined));
      // Compare effective refs, but filter their source positions so unrelated
      // placeholders and source-authored values survive the config write.
      const fallbacks =
        params.action === "add"
          ? existingKeys.includes(targetKey)
            ? existing
            : [...existing, targetKey]
          : existing.filter((_, index) => existingKeys[index] !== targetKey);
      if (params.action === "remove" && fallbacks.length === existing.length) {
        throw new Error(
          `${params.notFoundLabel} not found: ${targetKey}. Run ${formatCliCommand(`openclaw ${listCommandForFallbackKey(params.key)}`)} to see configured fallbacks.`,
        );
      }

      return patchDefaultsFallbacks(cfg, { key: params.key, fallbacks, models: nextModels });
    },
    (_, { runtimeConfig }) => [
      resolveModelTarget({ raw: modelRaw, cfg: runtimeConfig }),
      ...resolveModelRefsFromEntries({
        cfg: runtimeConfig,
        entries: getFallbacks(runtimeConfig, params.key),
      }),
    ],
  );

  logConfigUpdated(runtime);
  runtime.log(`${params.label}: ${getFallbacks(updated, params.key).join(", ")}`);
}

export async function clearFallbacksCommand(
  params: { key: DefaultsFallbackKey; clearedMessage: string },
  runtime: RuntimeEnv,
) {
  await updateConfig((cfg) => {
    return patchDefaultsFallbacks(cfg, { key: params.key, fallbacks: [] });
  });

  logConfigUpdated(runtime);
  runtime.log(params.clearedMessage);
}
