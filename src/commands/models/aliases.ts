import {
  CONFIG_PATH_CLAWDBOT,
  loadConfig,
} from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";
import {
  ensureFlagCompatibility,
  normalizeAlias,
  resolveModelTarget,
  updateConfig,
} from "./shared.js";

export async function modelsAliasesListCommand(
  opts: { json?: boolean; plain?: boolean },
  runtime: RuntimeEnv,
) {
  ensureFlagCompatibility(opts);
  const cfg = loadConfig();
  const aliases = cfg.agent?.modelAliases ?? {};

  if (opts.json) {
    runtime.log(JSON.stringify({ aliases }, null, 2));
    return;
  }
  if (opts.plain) {
    for (const [alias, target] of Object.entries(aliases)) {
      runtime.log(`${alias} ${target}`);
    }
    return;
  }

  runtime.log(`Aliases (${Object.keys(aliases).length}):`);
  if (Object.keys(aliases).length === 0) {
    runtime.log("- none");
    return;
  }
  for (const [alias, target] of Object.entries(aliases)) {
    runtime.log(`- ${alias} -> ${target}`);
  }
}

export async function modelsAliasesAddCommand(
  aliasRaw: string,
  modelRaw: string,
  runtime: RuntimeEnv,
) {
  const alias = normalizeAlias(aliasRaw);
  const updated = await updateConfig((cfg) => {
    const resolved = resolveModelTarget({ raw: modelRaw, cfg });
    const nextAliases = { ...(cfg.agent?.modelAliases ?? {}) };
    nextAliases[alias] = `${resolved.provider}/${resolved.model}`;
    return {
      ...cfg,
      agent: {
        ...cfg.agent,
        modelAliases: nextAliases,
      },
    };
  });

  runtime.log(`Updated ${CONFIG_PATH_CLAWDBOT}`);
  runtime.log(`Alias ${alias} -> ${updated.agent?.modelAliases?.[alias]}`);
}

export async function modelsAliasesRemoveCommand(
  aliasRaw: string,
  runtime: RuntimeEnv,
) {
  const alias = normalizeAlias(aliasRaw);
  const updated = await updateConfig((cfg) => {
    const nextAliases = { ...(cfg.agent?.modelAliases ?? {}) };
    if (!nextAliases[alias]) {
      throw new Error(`Alias not found: ${alias}`);
    }
    delete nextAliases[alias];
    return {
      ...cfg,
      agent: {
        ...cfg.agent,
        modelAliases: nextAliases,
      },
    };
  });

  runtime.log(`Updated ${CONFIG_PATH_CLAWDBOT}`);
  if (!updated.agent?.modelAliases || Object.keys(updated.agent.modelAliases).length === 0) {
    runtime.log("No aliases configured.");
  }
}
