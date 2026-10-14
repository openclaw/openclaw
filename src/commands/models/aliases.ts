import { formatCliCommand } from "../../cli/command-format.js";
import { DEFAULT_MODEL_ALIASES } from "../../config/defaults.js";
import { logConfigUpdated } from "../../config/logging.js";
import { normalizeAgentModelMapForConfig } from "../../config/model-input.js";
import { type RuntimeEnv, writeRuntimeJson, writeRuntimeStdout } from "../../runtime.js";
import { normalizeAlias } from "./alias-name.js";
import { loadModelsConfig } from "./load-config.js";
import {
  ensureFlagCompatibility,
  resolveModelTarget,
  requireKnownModelProvider,
  upsertCanonicalModelConfigEntry,
  updateConfig,
} from "./shared.js";

export async function modelsAliasesListCommand(
  opts: { json?: boolean; plain?: boolean },
  runtime: RuntimeEnv,
) {
  ensureFlagCompatibility(opts);
  const cfg = await loadModelsConfig({ commandName: "models aliases list", runtime });
  const models = cfg.agents?.defaults?.models ?? {};
  const aliases = Object.fromEntries(
    Object.entries(models).flatMap(([modelKey, entry]) => {
      const alias = entry?.alias?.trim();
      return alias ? [[alias, modelKey] as const] : [];
    }),
  );
  const aliasEntries = Object.entries(aliases).toSorted(([left], [right]) =>
    left.localeCompare(right),
  );

  if (opts.json) {
    writeRuntimeJson(runtime, { aliases: Object.fromEntries(aliasEntries) });
    return;
  }
  if (opts.plain) {
    for (const [alias, target] of aliasEntries) {
      writeRuntimeStdout(runtime, `${alias} ${target}`);
    }
    return;
  }

  runtime.log(`Aliases (${aliasEntries.length}):`);
  if (aliasEntries.length === 0) {
    runtime.log("- none");
    return;
  }
  for (const [alias, target] of aliasEntries) {
    runtime.log(`- ${alias} -> ${target}`);
  }
}

export async function modelsAliasesAddCommand(
  aliasRaw: string,
  modelRaw: string,
  runtime: RuntimeEnv,
) {
  const alias = normalizeAlias(aliasRaw);
  const normalizedAlias = alias.toLowerCase();
  let target = modelRaw;
  let warning: string | undefined;
  await updateConfig(
    (cfgLocal, context) => {
      // Alias resolution must share the snapshot whose hash fences this write.
      const resolved = resolveModelTarget({ raw: modelRaw, cfg: context.runtimeConfig });
      warning = requireKnownModelProvider(
        context.runtimeConfig,
        resolved,
        context.providerRegistryAvailable,
      ).warning;
      const nextModels = { ...cfgLocal.agents?.defaults?.models };
      const modelKey = upsertCanonicalModelConfigEntry(nextModels, resolved, context);
      target = modelKey;
      // Model selection folds alias case, so case variants must not collide.
      for (const [key, entry] of Object.entries(nextModels)) {
        const existing = entry?.alias?.trim();
        if (existing && existing.toLowerCase() === normalizedAlias && key !== modelKey) {
          throw new Error(`Alias ${alias} already points to ${key}.`);
        }
      }
      nextModels[modelKey] = { ...nextModels[modelKey], alias };
      cfgLocal.agents ??= {};
      cfgLocal.agents.defaults ??= {};
      cfgLocal.agents.defaults.models = nextModels;
      return cfgLocal;
    },
    (_cfg, context) => [resolveModelTarget({ raw: modelRaw, cfg: context.runtimeConfig })],
  );

  if (warning) {
    runtime.error?.(warning);
  }
  logConfigUpdated(runtime);
  runtime.log(`Alias ${alias} -> ${target}`);
}

export async function modelsAliasesRemoveCommand(aliasRaw: string, runtime: RuntimeEnv) {
  const alias = normalizeAlias(aliasRaw);
  const normalizedAlias = alias.toLowerCase();
  const updated = await updateConfig((cfg) => {
    const nextModels = { ...cfg.agents?.defaults?.models };
    let found = false;
    for (const [key, entry] of Object.entries(nextModels)) {
      if (entry?.alias?.trim().toLowerCase() === normalizedAlias) {
        nextModels[key] = { ...entry, alias: undefined };
        found = true;
      }
    }
    if (!found) {
      // Built-in aliases are runtime defaults, not authored config. Match list output's
      // normalized model keys while retaining explicit alias opt-outs.
      const builtinTarget = DEFAULT_MODEL_ALIASES[normalizedAlias];
      const normalizedModels = normalizeAgentModelMapForConfig(nextModels);
      if (
        builtinTarget &&
        normalizedModels[builtinTarget] &&
        normalizedModels[builtinTarget]?.alias === undefined
      ) {
        throw new Error(
          `Cannot remove "${alias}": it is a built-in alias for "${builtinTarget}" provided automatically by OpenClaw and is not stored in your config file. To shadow it with a different target, run ${formatCliCommand(`openclaw models aliases add ${alias} <model>`)}.`,
        );
      }
      throw new Error(
        `Alias not found: ${alias}. Run ${formatCliCommand("openclaw models aliases list")} to see configured aliases.`,
      );
    }
    cfg.agents ??= {};
    cfg.agents.defaults ??= {};
    cfg.agents.defaults.models = nextModels;
    return cfg;
  });

  logConfigUpdated(runtime);
  if (
    Object.values(updated.agents?.defaults?.models ?? {}).every((entry) => !entry?.alias?.trim())
  ) {
    runtime.log("No aliases configured.");
  }
}
