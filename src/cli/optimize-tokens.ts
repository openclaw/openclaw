import fs from "node:fs/promises";
import path from "node:path";
import { readConfigFileSnapshot } from "../config/config.js";
import { danger, info, success } from "../globals.js";
import { defaultRuntime } from "../runtime.js";
import type { OpenClawConfig } from "../config/types.js";

const OPTIMIZATION_FILE = "optimization.json";

export async function optimizeTokens() {
  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.valid) {
    defaultRuntime.error(danger(`Config invalid. Run "openclaw doctor" first.`));
    defaultRuntime.exit(1);
    return;
  }

  const configPath = snapshot.path;
  const configDir = path.dirname(configPath);
  const optimizationPath = path.join(configDir, OPTIMIZATION_FILE);

  // 1. Generate optimization settings
  const optimizationConfig = generateOptimizationConfig(snapshot.config);

  // 2. Write optimization.json
  await fs.writeFile(
    optimizationPath,
    JSON.stringify(optimizationConfig, null, 2),
    "utf-8",
  );
  defaultRuntime.log(info(`Created ${OPTIMIZATION_FILE} with optimization settings.`));

  // 3. Update openclaw.json to include optimization.json
  // We manipulate the parsed JSON structure directly to preserve as much as possible,
  // though comments/formatting might still be lost by JSON.stringify.
  let currentConfig = snapshot.parsed as Record<string, unknown>;
  if (!currentConfig || typeof currentConfig !== "object") {
    currentConfig = {};
  }

  const includeKey = "$include";
  const includes = currentConfig[includeKey];
  const optimizationInclude = `./${OPTIMIZATION_FILE}`;
  let changed = false;

  if (typeof includes === "string") {
    if (includes !== optimizationInclude) {
      currentConfig[includeKey] = [includes, optimizationInclude];
      changed = true;
    }
  } else if (Array.isArray(includes)) {
    if (!includes.includes(optimizationInclude)) {
      currentConfig[includeKey] = [...includes, optimizationInclude];
      changed = true;
    }
  } else {
    currentConfig[includeKey] = [optimizationInclude];
    changed = true;
  }

  if (changed) {
    const json = JSON.stringify(currentConfig, null, 2);
    await fs.writeFile(configPath, json, "utf-8");
    defaultRuntime.log(success(`Updated ${path.basename(configPath)} to include ${OPTIMIZATION_FILE}.`));
  } else {
    defaultRuntime.log(info(`${path.basename(configPath)} already includes ${OPTIMIZATION_FILE}.`));
  }

  defaultRuntime.log(success("Optimization enabled. Restart the gateway to apply."));
}

function generateOptimizationConfig(currentConfig: OpenClawConfig) {
  const optimizedModels: Record<string, any> = {
    "anthropic/claude-opus-4-5": {
      params: {
        cacheRetention: "long",
      },
    },
  };

  // Merge any other detected Anthropic models from current config
  const existingModels = currentConfig.agents?.defaults?.models;
  if (existingModels) {
    for (const [key, model] of Object.entries(existingModels)) {
      if (key.includes("anthropic") || (model as any)?.provider === "anthropic") {
        if (!optimizedModels[key]) {
          optimizedModels[key] = {
            params: {
              cacheRetention: "long",
            },
          };
        }
      }
    }
  }

  return {
    agents: {
      defaults: {
        contextPruning: {
          mode: "cache-ttl",
          ttl: "5m",
          softTrimRatio: 0.3,
          hardClearRatio: 0.5,
        },
        compaction: {
          mode: "safeguard",
          reserveTokensFloor: 20000,
          memoryFlush: {
            enabled: true,
          },
        },
        memorySearch: {
          provider: "local",
          fallback: "none",
          cache: {
            enabled: true,
          },
        },
        heartbeat: {
          every: "55m",
        },
        models: optimizedModels,
      },
    },
  };
}
