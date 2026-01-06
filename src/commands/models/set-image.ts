import { CONFIG_PATH_CLAWDBOT } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";
import { resolveModelTarget, updateConfig } from "./shared.js";

export async function modelsSetImageCommand(
  modelRaw: string,
  runtime: RuntimeEnv,
) {
  const updated = await updateConfig((cfg) => {
    const resolved = resolveModelTarget({ raw: modelRaw, cfg });
    const key = `${resolved.provider}/${resolved.model}`;
    const nextModels = { ...cfg.agent?.models };
    if (!nextModels[key]) nextModels[key] = {};
    return {
      ...cfg,
      agent: {
        ...cfg.agent,
        imageModel: {
          ...((cfg.agent?.imageModel as {
            primary?: string;
            fallbacks?: string[];
          }) ?? {}),
          primary: key,
        },
        models: nextModels,
      },
    };
  });

  runtime.log(`Updated ${CONFIG_PATH_CLAWDBOT}`);
  runtime.log(`Image model: ${updated.agent?.imageModel?.primary ?? modelRaw}`);
}
