import { CONFIG_PATH_CLAWDBOT } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";
import { resolveModelTarget, updateConfig } from "./shared.js";

export async function modelsSetImageCommand(modelRaw: string, runtime: RuntimeEnv) {
  const updated = await updateConfig((cfg) => {
    const resolved = resolveModelTarget({ raw: modelRaw, cfg });
    const key = `${resolved.provider}/${resolved.model}`;
    const nextModels = { ...cfg.agents?.defaults?.models };
    if (!nextModels[key]) nextModels[key] = {};
    const existingModel = cfg.agents?.defaults?.imageModel as
      | { primary?: string; fallbacks?: string[] }
      | undefined;
    return {
      ...cfg,
      agents: {
        ...cfg.agents,
        defaults: {
          ...cfg.agents?.defaults,
          imageModel: {
            ...(existingModel?.fallbacks ? { fallbacks: existingModel.fallbacks } : undefined),
            primary: key,
          },
          models: nextModels,
        },
      },
    };
  });

  runtime.log(`Updated ${CONFIG_PATH_CLAWDBOT}`);
  runtime.log(`Image model: ${updated.agents?.defaults?.imageModel?.primary ?? modelRaw}`);
}
