import { loadConfig, writeConfigFile } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import type { RuntimeEnv } from "../../runtime.js";

export async function modelsLocalGgufUnloadCommand(
  opts: {
    model?: string;
    all?: boolean;
    timeoutMs?: number;
  },
  runtime: RuntimeEnv,
) {
  if (!opts.model && !opts.all) {
    throw new Error("Specify --model <path> or --all");
  }

  const result = await callGateway<{ message: string }>({
    method: "models.local-gguf.unload",
    params: {
      modelPath: opts.model,
      all: opts.all,
    },
    timeoutMs: opts.timeoutMs,
  });

  if (result) {
    runtime.log(result.message);
  }
}

export async function modelsLocalGgufConfigCommand(
  opts: {
    path?: string;
    limit?: number;
  },
  runtime: RuntimeEnv,
) {
  const cfg = loadConfig();

  if (opts.path === undefined && opts.limit === undefined) {
    const current = cfg.models?.providers?.["local-gguf"];
    runtime.log(`Current Local GGUF Config:`);
    runtime.log(`  Path:  ${current?.baseUrl || "Not set"}`);
    runtime.log(`  Limit: ${current?.maxCachedModels ?? 5} (model cache)`);
    return;
  }

  if (!cfg.models) {
    cfg.models = {};
  }
  if (!cfg.models.providers) {
    cfg.models.providers = {};
  }
  if (!cfg.models.providers["local-gguf"]) {
    cfg.models.providers["local-gguf"] = {
      baseUrl: "",
      models: [],
    };
  }

  const provider = cfg.models.providers["local-gguf"];

  if (opts.path !== undefined) {
    provider.baseUrl = `file://${opts.path}`;
    runtime.log(`Local GGUF path set to: ${opts.path}`);
  }

  if (opts.limit !== undefined) {
    const limit = Number(opts.limit);
    if (Number.isNaN(limit) || limit < 1) {
      throw new Error("Limit must be a positive number");
    }
    provider.maxCachedModels = limit;
    runtime.log(`Model cache limit set to ${limit}.`);
  }

  await writeConfigFile(cfg);
  runtime.log(
    `\nConfig saved. You may need to restart the agent/gateway for changes to take full effect.`,
  );
}
