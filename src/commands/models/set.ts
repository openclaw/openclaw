import type { RuntimeEnv } from "../../runtime.js";
import { logConfigUpdated } from "../../config/logging.js";
import {
  mergePrimaryFallbackConfig,
  type PrimaryFallbackConfig,
  resolveModelTarget,
  updateConfig,
} from "./shared.js";

export async function modelsSetCommand(modelRaw: string, runtime: RuntimeEnv) {
  const updated = await updateConfig((cfg) => {
    const resolved = resolveModelTarget({ raw: modelRaw, cfg });
    const key = `${resolved.provider}/${resolved.model}`;
    const nextModels = { ...cfg.agents?.defaults?.models };
    if (!nextModels[key]) {
      nextModels[key] = {};
    }
    return {
      ...cfg,
      agents: {
        ...cfg.agents,
        defaults: {
          ...cfg.agents?.defaults,
          model: mergePrimaryFallbackConfig(
            cfg.agents?.defaults?.model as unknown as PrimaryFallbackConfig | undefined,
            { primary: key },
          ),
          models: nextModels,
        },
      },
    };
  });

  logConfigUpdated(runtime);
  runtime.log(`Default model: ${updated.agents?.defaults?.model?.primary ?? modelRaw}`);
}
