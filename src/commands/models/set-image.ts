import { CONFIG_PATH_CLAWDBOT } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";
import {
  buildAllowlistSet,
  modelKey,
  resolveModelTarget,
  updateConfig,
} from "./shared.js";

export async function modelsSetImageCommand(
  modelRaw: string,
  runtime: RuntimeEnv,
) {
  const updated = await updateConfig((cfg) => {
    const resolved = resolveModelTarget({ raw: modelRaw, cfg });
    const allowlist = buildAllowlistSet(cfg);
    if (allowlist.size > 0) {
      const key = modelKey(resolved.provider, resolved.model);
      if (!allowlist.has(key)) {
        throw new Error(`Model ${key} is not in agent.allowedModels.`);
      }
    }
    return {
      ...cfg,
      agent: {
        ...cfg.agent,
        imageModel: `${resolved.provider}/${resolved.model}`,
      },
    };
  });

  runtime.log(`Updated ${CONFIG_PATH_CLAWDBOT}`);
  runtime.log(`Image model: ${updated.agent?.imageModel ?? modelRaw}`);
}
