import * as clack from "@clack/prompts";

import { discoverLMStudioModels } from "../../agents/models-config.providers.js";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
import { logConfigUpdated } from "../../config/logging.js";
import type { RuntimeEnv } from "../../runtime.js";
import { theme } from "../../terminal/theme.js";
import { updateConfig } from "./shared.js";

export const DEFAULT_LMSTUDIO_URL = "http://127.0.0.1:1234/v1";
export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434/v1";
const OLLAMA_API_URL = "http://127.0.0.1:11434";

export interface LocalModelSetupOptions {
  url?: string;
  setDefault?: boolean;
  yes?: boolean;
}

interface OllamaModel {
  name: string;
  modified_at: string;
  size: number;
  digest: string;
  details?: {
    family?: string;
    parameter_size?: string;
  };
}

interface OllamaTagsResponse {
  models: OllamaModel[];
}

/**
 * Discover models from Ollama via /api/tags endpoint.
 */
export async function discoverOllamaModelsFromUrl(
  baseUrl?: string,
): Promise<ModelDefinitionConfig[]> {
  const apiUrl = baseUrl?.replace(/\/v1\/?$/, "") ?? OLLAMA_API_URL;
  try {
    const response = await fetch(`${apiUrl}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return [];
    }
    const data = (await response.json()) as OllamaTagsResponse;
    if (!data.models || data.models.length === 0) {
      return [];
    }
    return data.models.map((model) => {
      const modelId = model.name;
      const idLower = modelId.toLowerCase();
      const isReasoning =
        idLower.includes("r1") ||
        idLower.includes("reasoning") ||
        idLower.includes("think");
      const isVision =
        idLower.includes("vision") ||
        idLower.includes("-vl") ||
        idLower.includes("vl-") ||
        idLower.includes("llava");
      return {
        id: modelId,
        name: modelId,
        reasoning: isReasoning,
        input: isVision ? (["text", "image"] as const) : (["text"] as const),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
      };
    });
  } catch {
    return [];
  }
}

// ============================================================================
// LM Studio Commands
// ============================================================================

export async function modelsLMStudioSetupCommand(
  opts: LocalModelSetupOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  let baseUrl = opts.url ?? process.env.LMSTUDIO_BASE_URL ?? DEFAULT_LMSTUDIO_URL;

  // If no URL provided and not --yes, prompt for it
  if (!opts.url && !opts.yes) {
    const urlInput = await clack.text({
      message: "LM Studio server URL",
      placeholder: DEFAULT_LMSTUDIO_URL,
      defaultValue: DEFAULT_LMSTUDIO_URL,
      validate: (value) => {
        try {
          new URL(value);
          return undefined;
        } catch {
          return "Invalid URL";
        }
      },
    });
    if (clack.isCancel(urlInput)) {
      clack.cancel("Setup cancelled");
      return;
    }
    baseUrl = urlInput || DEFAULT_LMSTUDIO_URL;
  }

  // Discover models
  const spinner = clack.spinner();
  spinner.start(`Discovering models at ${baseUrl}...`);

  const models = await discoverLMStudioModels(baseUrl);

  if (models.length === 0) {
    spinner.stop(`${theme.error("No models found")} at ${baseUrl}`);
    runtime.log(theme.muted("\nMake sure LM Studio is running and has a model loaded."));
    runtime.log(theme.muted(`Test with: curl ${baseUrl}/models`));
    return;
  }

  spinner.stop(`Found ${models.length} model(s)`);

  // Display discovered models
  runtime.log("");
  for (const model of models) {
    const tags: string[] = [];
    if (model.reasoning) tags.push("reasoning");
    if (model.input?.includes("image")) tags.push("vision");
    const tagStr = tags.length > 0 ? ` ${theme.muted(`(${tags.join(", ")})`)}` : "";
    runtime.log(`  ${theme.success("+")} ${model.id}${tagStr}`);
  }
  runtime.log("");

  // Select default model
  let selectedModel: ModelDefinitionConfig | undefined;
  if (!opts.yes && models.length > 1) {
    const modelOptions = models.map((m) => ({
      value: m.id,
      label: m.id,
      hint: m.reasoning ? "reasoning" : undefined,
    }));

    const selected = await clack.select({
      message: "Select default model",
      options: modelOptions,
    });

    if (clack.isCancel(selected)) {
      clack.cancel("Setup cancelled");
      return;
    }

    selectedModel = models.find((m) => m.id === selected);
  } else {
    selectedModel = models[0];
  }

  // Build provider config
  const providerConfig = {
    baseUrl,
    apiKey: "lmstudio",
    api: "openai-completions" as const,
    models,
  };

  // Update config
  await updateConfig((cfg) => {
    const nextConfig = {
      ...cfg,
      models: {
        ...cfg.models,
        mode: cfg.models?.mode ?? "merge",
        providers: {
          ...cfg.models?.providers,
          lmstudio: providerConfig,
        },
      },
    };

    // Set as default if requested
    if (opts.setDefault && selectedModel) {
      const modelId = `lmstudio/${selectedModel.id}`;
      const existingModel = cfg.agents?.defaults?.model as
        | { primary?: string; fallbacks?: string[] }
        | undefined;
      nextConfig.agents = {
        ...nextConfig.agents,
        defaults: {
          ...nextConfig.agents?.defaults,
          model: {
            ...(existingModel?.fallbacks ? { fallbacks: existingModel.fallbacks } : undefined),
            primary: modelId,
          },
        },
      };
    }

    return nextConfig;
  });

  logConfigUpdated(runtime);

  if (selectedModel) {
    const modelId = `lmstudio/${selectedModel.id}`;
    if (opts.setDefault) {
      runtime.log(`Default model: ${theme.accent(modelId)}`);
    } else {
      runtime.log(theme.muted(`\nTo set as default: clawdbot models set ${modelId}`));
    }
  }

  runtime.log(theme.muted(`\nConfigured ${models.length} model(s) from ${baseUrl}`));
}

export async function modelsLMStudioDiscoverCommand(
  opts: { url?: string; json?: boolean },
  runtime: RuntimeEnv,
): Promise<void> {
  const baseUrl = opts.url ?? process.env.LMSTUDIO_BASE_URL ?? DEFAULT_LMSTUDIO_URL;
  const models = await discoverLMStudioModels(baseUrl);

  if (opts.json) {
    runtime.log(JSON.stringify({ baseUrl, models }, null, 2));
    return;
  }

  if (models.length === 0) {
    runtime.log(theme.error(`No models found at ${baseUrl}`));
    runtime.log(theme.muted(`\nMake sure LM Studio is running and has a model loaded.`));
    return;
  }

  runtime.log(`Models at ${theme.accent(baseUrl)}:\n`);
  for (const model of models) {
    const tags: string[] = [];
    if (model.reasoning) tags.push("reasoning");
    if (model.input?.includes("image")) tags.push("vision");
    const tagStr = tags.length > 0 ? ` ${theme.muted(`(${tags.join(", ")})`)}` : "";
    runtime.log(`  ${model.id}${tagStr}`);
  }
}

// ============================================================================
// Ollama Commands
// ============================================================================

export async function modelsOllamaSetupCommand(
  opts: LocalModelSetupOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  let baseUrl = opts.url ?? process.env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_URL;

  // If no URL provided and not --yes, prompt for it
  if (!opts.url && !opts.yes) {
    const urlInput = await clack.text({
      message: "Ollama server URL",
      placeholder: DEFAULT_OLLAMA_URL,
      defaultValue: DEFAULT_OLLAMA_URL,
      validate: (value) => {
        try {
          new URL(value);
          return undefined;
        } catch {
          return "Invalid URL";
        }
      },
    });
    if (clack.isCancel(urlInput)) {
      clack.cancel("Setup cancelled");
      return;
    }
    baseUrl = urlInput || DEFAULT_OLLAMA_URL;
  }

  // Discover models
  const spinner = clack.spinner();
  spinner.start(`Discovering models at ${baseUrl}...`);

  const models = await discoverOllamaModelsFromUrl(baseUrl);

  if (models.length === 0) {
    spinner.stop(`${theme.error("No models found")} at ${baseUrl}`);
    runtime.log(theme.muted("\nMake sure Ollama is running. Start with: ollama serve"));
    runtime.log(theme.muted(`Test with: curl ${baseUrl.replace(/\/v1\/?$/, "")}/api/tags`));
    return;
  }

  spinner.stop(`Found ${models.length} model(s)`);

  // Display discovered models
  runtime.log("");
  for (const model of models) {
    const tags: string[] = [];
    if (model.reasoning) tags.push("reasoning");
    if (model.input?.includes("image")) tags.push("vision");
    const tagStr = tags.length > 0 ? ` ${theme.muted(`(${tags.join(", ")})`)}` : "";
    runtime.log(`  ${theme.success("+")} ${model.id}${tagStr}`);
  }
  runtime.log("");

  // Select default model
  let selectedModel: ModelDefinitionConfig | undefined;
  if (!opts.yes && models.length > 1) {
    const modelOptions = models.map((m) => ({
      value: m.id,
      label: m.id,
      hint: m.reasoning ? "reasoning" : undefined,
    }));

    const selected = await clack.select({
      message: "Select default model",
      options: modelOptions,
    });

    if (clack.isCancel(selected)) {
      clack.cancel("Setup cancelled");
      return;
    }

    selectedModel = models.find((m) => m.id === selected);
  } else {
    selectedModel = models[0];
  }

  // Build provider config - ensure baseUrl ends with /v1
  const normalizedUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl.replace(/\/$/, "")}/v1`;
  const providerConfig = {
    baseUrl: normalizedUrl,
    apiKey: "ollama",
    api: "openai-completions" as const,
    models,
  };

  // Update config
  await updateConfig((cfg) => {
    const nextConfig = {
      ...cfg,
      models: {
        ...cfg.models,
        mode: cfg.models?.mode ?? "merge",
        providers: {
          ...cfg.models?.providers,
          ollama: providerConfig,
        },
      },
    };

    // Set as default if requested
    if (opts.setDefault && selectedModel) {
      const modelId = `ollama/${selectedModel.id}`;
      const existingModel = cfg.agents?.defaults?.model as
        | { primary?: string; fallbacks?: string[] }
        | undefined;
      nextConfig.agents = {
        ...nextConfig.agents,
        defaults: {
          ...nextConfig.agents?.defaults,
          model: {
            ...(existingModel?.fallbacks ? { fallbacks: existingModel.fallbacks } : undefined),
            primary: modelId,
          },
        },
      };
    }

    return nextConfig;
  });

  logConfigUpdated(runtime);

  if (selectedModel) {
    const modelId = `ollama/${selectedModel.id}`;
    if (opts.setDefault) {
      runtime.log(`Default model: ${theme.accent(modelId)}`);
    } else {
      runtime.log(theme.muted(`\nTo set as default: clawdbot models set ${modelId}`));
    }
  }

  runtime.log(theme.muted(`\nConfigured ${models.length} model(s) from ${baseUrl}`));
}

export async function modelsOllamaDiscoverCommand(
  opts: { url?: string; json?: boolean },
  runtime: RuntimeEnv,
): Promise<void> {
  const baseUrl = opts.url ?? process.env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_URL;
  const models = await discoverOllamaModelsFromUrl(baseUrl);

  if (opts.json) {
    runtime.log(JSON.stringify({ baseUrl, models }, null, 2));
    return;
  }

  if (models.length === 0) {
    runtime.log(theme.error(`No models found at ${baseUrl}`));
    runtime.log(theme.muted(`\nMake sure Ollama is running. Start with: ollama serve`));
    return;
  }

  runtime.log(`Models at ${theme.accent(baseUrl)}:\n`);
  for (const model of models) {
    const tags: string[] = [];
    if (model.reasoning) tags.push("reasoning");
    if (model.input?.includes("image")) tags.push("vision");
    const tagStr = tags.length > 0 ? ` ${theme.muted(`(${tags.join(", ")})`)}` : "";
    runtime.log(`  ${model.id}${tagStr}`);
  }
}

// ============================================================================
// Unified Local Models Wizard
// ============================================================================

export async function modelsLocalSetupCommand(
  opts: LocalModelSetupOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  // Auto-detect available servers
  const spinner = clack.spinner();
  spinner.start("Detecting local model servers...");

  const [lmstudioModels, ollamaModels] = await Promise.all([
    discoverLMStudioModels(opts.url ?? DEFAULT_LMSTUDIO_URL),
    discoverOllamaModelsFromUrl(opts.url ?? DEFAULT_OLLAMA_URL),
  ]);

  const hasLmstudio = lmstudioModels.length > 0;
  const hasOllama = ollamaModels.length > 0;

  if (!hasLmstudio && !hasOllama) {
    spinner.stop(theme.error("No local model servers detected"));
    runtime.log("");
    runtime.log(theme.muted("Start one of the following:"));
    runtime.log(theme.muted("  - LM Studio: Download from https://lmstudio.ai, load a model, start server"));
    runtime.log(theme.muted("  - Ollama: Install from https://ollama.ai, run: ollama serve"));
    runtime.log("");
    runtime.log(theme.muted("Or specify a custom URL:"));
    runtime.log(theme.muted("  clawdbot models lmstudio setup --url http://your-server:1234/v1"));
    runtime.log(theme.muted("  clawdbot models ollama setup --url http://your-server:11434/v1"));
    return;
  }

  const detected: string[] = [];
  if (hasLmstudio) detected.push(`LM Studio (${lmstudioModels.length} models)`);
  if (hasOllama) detected.push(`Ollama (${ollamaModels.length} models)`);
  spinner.stop(`Detected: ${detected.join(", ")}`);

  // If only one server available, use it directly
  if (hasLmstudio && !hasOllama) {
    await modelsLMStudioSetupCommand({ ...opts, url: opts.url ?? DEFAULT_LMSTUDIO_URL }, runtime);
    return;
  }
  if (hasOllama && !hasLmstudio) {
    await modelsOllamaSetupCommand({ ...opts, url: opts.url ?? DEFAULT_OLLAMA_URL }, runtime);
    return;
  }

  // Both available - let user choose
  if (!opts.yes) {
    const choice = await clack.select({
      message: "Which local server do you want to configure?",
      options: [
        { value: "lmstudio", label: "LM Studio", hint: `${lmstudioModels.length} models` },
        { value: "ollama", label: "Ollama", hint: `${ollamaModels.length} models` },
        { value: "both", label: "Both", hint: "Configure both servers" },
      ],
    });

    if (clack.isCancel(choice)) {
      clack.cancel("Setup cancelled");
      return;
    }

    if (choice === "lmstudio" || choice === "both") {
      await modelsLMStudioSetupCommand({ ...opts, url: opts.url ?? DEFAULT_LMSTUDIO_URL }, runtime);
    }
    if (choice === "ollama" || choice === "both") {
      await modelsOllamaSetupCommand({ ...opts, url: opts.url ?? DEFAULT_OLLAMA_URL }, runtime);
    }
  } else {
    // --yes mode: configure both
    await modelsLMStudioSetupCommand({ ...opts, url: opts.url ?? DEFAULT_LMSTUDIO_URL }, runtime);
    await modelsOllamaSetupCommand({ ...opts, url: opts.url ?? DEFAULT_OLLAMA_URL }, runtime);
  }
}
