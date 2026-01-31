import { logConfigUpdated } from "../../config/logging.js";
import type { RuntimeEnv } from "../../runtime.js";
import { resolveModelTarget, updateConfig, validateModelInCatalog } from "./shared.js";

export async function modelsSetCommand(
  modelRaw: string,
  runtime: RuntimeEnv,
  opts?: { force?: boolean },
) {
  const cfg = (await import("../../config/config.js")).loadConfig();
  const resolved = resolveModelTarget({ raw: modelRaw, cfg });
  const key = `${resolved.provider}/${resolved.model}`;

  // Validate model exists in catalog unless --force is used
  const validation = await validateModelInCatalog(resolved.provider, resolved.model);
  if (!validation.valid) {
    if (opts?.force) {
      runtime.log(`⚠️ Model not found in catalog: ${key}. Proceeding anyway (--force).`);
    } else {
      const suggestionText =
        validation.suggestions && validation.suggestions.length > 0
          ? `\nDid you mean: ${validation.suggestions.join(", ")}?`
          : "";
      throw new Error(`Unknown model: ${key}${suggestionText}\nUse --force to skip validation.`);
    }
  }

  const updated = await updateConfig((cfgSnapshot) => {
    const nextModels = { ...cfgSnapshot.agents?.defaults?.models };
    if (!nextModels[key]) nextModels[key] = {};
    const existingModel = cfgSnapshot.agents?.defaults?.model as
      | { primary?: string; fallbacks?: string[] }
      | undefined;
    return {
      ...cfgSnapshot,
      agents: {
        ...cfgSnapshot.agents,
        defaults: {
          ...cfgSnapshot.agents?.defaults,
          model: {
            ...(existingModel?.fallbacks ? { fallbacks: existingModel.fallbacks } : undefined),
            primary: key,
          },
          models: nextModels,
        },
      },
    };
  });

  logConfigUpdated(runtime);
  runtime.log(`Default model: ${updated.agents?.defaults?.model?.primary ?? modelRaw}`);
}
