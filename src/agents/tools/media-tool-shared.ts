import { type Api, type Model } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../config/config.js";
import { getDefaultLocalRoots } from "../../web/media.js";
import type { ImageModelConfig } from "./image-tool.helpers.js";
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
  if (!cfg) {
    return undefined;
  }
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        imageModel: imageModelConfig,
      },
    },
  };
}

import { checkPathGuardStrict, type ToolFsPolicy } from "../tool-fs-policy.js";

// ... existing types ...

export function resolveMediaToolLocalRoots(
  workspaceDirRaw: string | undefined,
  options?: { fsPolicy?: ToolFsPolicy },
): string[] {
  const workspaceDir = normalizeWorkspaceDir(workspaceDirRaw);
  const policy = options?.fsPolicy;

  if (policy?.workspaceOnly) {
    return workspaceDir ? [workspaceDir] : [];
  }

  const defaultRoots = getDefaultLocalRoots();
  const allCandidates = workspaceDir ? [...defaultRoots, workspaceDir] : defaultRoots;

  // If we have a complex policy (allowed/deny paths), we need to filter the roots.
  // Note: checkPathGuardStrict throws if invalid, but here we just want to filter.
  // Actually, for media tools, we usually just want to know which roots are "plausible".
  // The actual tool execution will still be guarded if we wrap it, but media tools
  // often do their own path resolution.

  if (!policy || (!policy.allowedPaths?.length && !policy.denyPaths?.length)) {
    return Array.from(new Set(allCandidates));
  }

  return allCandidates.filter((root) => {
    try {
      // We check if the root itself is "accessible" under the policy.
      // We use a dummy filename to check directory access.
      checkPathGuardStrict(root, { ...policy, workspaceOnly: false }, "");
      return true;
    } catch {
      return false;
    }
  });
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
