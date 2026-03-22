import os from "node:os";
import path from "node:path";
import { type Api, type Model } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../config/config.js";
import { getDefaultLocalRoots } from "../../media/web-media.js";
import type { ImageModelConfig } from "./image-tool.helpers.js";
import type { ToolModelConfig } from "./model-config.helpers.js";
import { getApiKeyForModel, normalizeWorkspaceDir, requireApiKey } from "./tool-runtime.helpers.js";

type TextToolAttempt = {
  provider: string;
  model: string;
  error: string;
};

type TextToolResult = {
  text: string;
  provider: string;
  model: string;
  attempts: TextToolAttempt[];
};

export function applyImageModelConfigDefaults(
  cfg: OpenClawConfig | undefined,
  imageModelConfig: ImageModelConfig,
): OpenClawConfig | undefined {
  return applyAgentDefaultModelConfig(cfg, "imageModel", imageModelConfig);
}

export function applyImageGenerationModelConfigDefaults(
  cfg: OpenClawConfig | undefined,
  imageGenerationModelConfig: ToolModelConfig,
): OpenClawConfig | undefined {
  return applyAgentDefaultModelConfig(cfg, "imageGenerationModel", imageGenerationModelConfig);
}

function applyAgentDefaultModelConfig(
  cfg: OpenClawConfig | undefined,
  key: "imageModel" | "imageGenerationModel",
  modelConfig: ToolModelConfig,
): OpenClawConfig | undefined {
  if (!cfg) {
    return undefined;
  }
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        [key]: modelConfig,
      },
    },
  };
}

function normalizeMediaAllowedRoot(root: string): string {
  const trimmed = root.trim();
  if (!trimmed) {
    return trimmed;
  }
  const normalized = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  if (normalized === "~") {
    return os.homedir();
  }
  if (normalized.startsWith("~/") || normalized.startsWith("~\\")) {
    return path.join(os.homedir(), normalized.slice(2));
  }
  if (!path.isAbsolute(normalized)) {
    throw new Error(`allowedRoots entries must be absolute paths: ${root}`);
  }
  return path.resolve(normalized);
}

export function resolveMediaToolLocalRoots(
  workspaceDirRaw: string | undefined,
  options?: { workspaceOnly?: boolean; allowedRoots?: string[] },
): string[] {
  const workspaceDir = normalizeWorkspaceDir(workspaceDirRaw);
  const defaultRoots = getDefaultLocalRoots();
  const allowedRoots =
    options?.workspaceOnly === true
      ? (options?.allowedRoots ?? []).map(normalizeMediaAllowedRoot).filter(Boolean)
      : [];
  if (options?.workspaceOnly) {
    return Array.from(
      new Set([...defaultRoots, ...(workspaceDir ? [workspaceDir] : []), ...allowedRoots]),
    );
  }
  return Array.from(new Set([...defaultRoots, ...(workspaceDir ? [workspaceDir] : [])]));
}

export function resolvePromptAndModelOverride(
  args: Record<string, unknown>,
  defaultPrompt: string,
): {
  prompt: string;
  modelOverride?: string;
} {
  const prompt =
    typeof args.prompt === "string" && args.prompt.trim() ? args.prompt.trim() : defaultPrompt;
  const modelOverride =
    typeof args.model === "string" && args.model.trim() ? args.model.trim() : undefined;
  return { prompt, modelOverride };
}

export function buildTextToolResult(
  result: TextToolResult,
  extraDetails: Record<string, unknown>,
): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
} {
  return {
    content: [{ type: "text", text: result.text }],
    details: {
      model: `${result.provider}/${result.model}`,
      ...extraDetails,
      attempts: result.attempts,
    },
  };
}

export function resolveModelFromRegistry(params: {
  modelRegistry: { find: (provider: string, modelId: string) => unknown };
  provider: string;
  modelId: string;
}): Model<Api> {
  const model = params.modelRegistry.find(params.provider, params.modelId) as Model<Api> | null;
  if (!model) {
    throw new Error(`Unknown model: ${params.provider}/${params.modelId}`);
  }
  return model;
}

export async function resolveModelRuntimeApiKey(params: {
  model: Model<Api>;
  cfg: OpenClawConfig | undefined;
  agentDir: string;
  authStorage: {
    setRuntimeApiKey: (provider: string, apiKey: string) => void;
  };
}): Promise<string> {
  const apiKeyInfo = await getApiKeyForModel({
    model: params.model,
    cfg: params.cfg,
    agentDir: params.agentDir,
  });
  const apiKey = requireApiKey(apiKeyInfo, params.model.provider);
  params.authStorage.setRuntimeApiKey(params.model.provider, apiKey);
  return apiKey;
}
