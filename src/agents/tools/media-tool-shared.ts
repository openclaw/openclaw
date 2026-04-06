import path from "node:path";


import type { ToolFsPolicy } from "../tool-fs-policy.js";
import { type Api, type Model } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../config/config.js";
import type { AgentModelConfig } from "../../config/types.agents-shared.js";
import { getDefaultLocalRoots } from "../../media/web-media.js";
import { normalizeProviderId } from "../provider-id.js";
import type { ImageModelConfig } from "./image-tool.helpers.js";
import {
  buildToolModelConfigFromCandidates,
  coerceToolModelConfig,
  hasAuthForProvider,
  hasToolModelConfig,
  resolveDefaultModelRef,
  type ToolModelConfig,
} from "./model-config.helpers.js";
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
  return applyAgentDefaultModelConfig(
    cfg,
    "imageGenerationModel",
    imageGenerationModelConfig,
  );
}

export function applyVideoGenerationModelConfigDefaults(
  cfg: OpenClawConfig | undefined,
  videoGenerationModelConfig: ToolModelConfig,
): OpenClawConfig | undefined {
  return applyAgentDefaultModelConfig(cfg, "videoGenerationModel", videoGenerationModelConfig);
}

export function applyMusicGenerationModelConfigDefaults(
  cfg: OpenClawConfig | undefined,
  musicGenerationModelConfig: ToolModelConfig,
): OpenClawConfig | undefined {
  return applyAgentDefaultModelConfig(cfg, "musicGenerationModel", musicGenerationModelConfig);
}

function applyAgentDefaultModelConfig(
  cfg: OpenClawConfig | undefined,
  key: "imageModel" | "imageGenerationModel" | "videoGenerationModel" | "musicGenerationModel",
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

type CapabilityProvider = {
  id: string;
  aliases?: string[];
  defaultModel?: string;
  isConfigured?: (ctx: { cfg?: OpenClawConfig; agentDir?: string }) => boolean;
};

export function findCapabilityProviderById<T extends CapabilityProvider>(params: {
  providers: T[];
  providerId?: string;
}): T | undefined {
  const selectedProvider = normalizeProviderId(params.providerId ?? "");
  return params.providers.find(
    (provider) =>
      normalizeProviderId(provider.id) === selectedProvider ||
      (provider.aliases ?? []).some((alias) => normalizeProviderId(alias) === selectedProvider),
  );
}

export function isCapabilityProviderConfigured<T extends CapabilityProvider>(params: {
  providers: T[];
  provider?: T;
  providerId?: string;
  cfg?: OpenClawConfig;
  agentDir?: string;
}): boolean {
  const provider =
    params.provider ??
    findCapabilityProviderById({
      providers: params.providers,
      providerId: params.providerId,
    });
  if (!provider) {
    return params.providerId
      ? hasAuthForProvider({ provider: params.providerId, agentDir: params.agentDir })
      : false;
  }
  if (provider.isConfigured) {
    return provider.isConfigured({
      cfg: params.cfg,
      agentDir: params.agentDir,
    });
  }
  return hasAuthForProvider({ provider: provider.id, agentDir: params.agentDir });
}

export function resolveCapabilityModelCandidatesForTool<T extends CapabilityProvider>(params: {
  cfg?: OpenClawConfig;
  agentDir?: string;
  providers: T[];
}): string[] {
  const providerDefaults = new Map<string, string>();
  for (const provider of params.providers) {
    const providerId = provider.id.trim();
    const modelId = provider.defaultModel?.trim();
    if (
      !providerId ||
      !modelId ||
      providerDefaults.has(providerId) ||
      !isCapabilityProviderConfigured({
        providers: params.providers,
        provider,
        cfg: params.cfg,
        agentDir: params.agentDir,
      })
    ) {
      continue;
    }
    providerDefaults.set(providerId, `${providerId}/${modelId}`);
  }

  const primaryProvider = resolveDefaultModelRef(params.cfg).provider;
  const orderedProviders = [
    primaryProvider,
    ...[...providerDefaults.keys()]
      .filter((providerId) => providerId !== primaryProvider)
      .toSorted(),
  ];
  const orderedRefs: string[] = [];
  const seen = new Set<string>();
  for (const providerId of orderedProviders) {
    const ref = providerDefaults.get(providerId);
    if (!ref || seen.has(ref)) {
      continue;
    }
    seen.add(ref);
    orderedRefs.push(ref);
  }
  return orderedRefs;
}

export function resolveCapabilityModelConfigForTool<T extends CapabilityProvider>(params: {
  cfg?: OpenClawConfig;
  agentDir?: string;
  modelConfig?: AgentModelConfig;
  providers: T[];
}): ToolModelConfig | null {
  const explicit = coerceToolModelConfig(params.modelConfig);
  if (hasToolModelConfig(explicit)) {
    return explicit;
  }
  return buildToolModelConfigFromCandidates({
    explicit,
    agentDir: params.agentDir,
    candidates: resolveCapabilityModelCandidatesForTool({
      cfg: params.cfg,
      agentDir: params.agentDir,
      providers: params.providers,
    }),
    isProviderConfigured: (providerId) =>
      isCapabilityProviderConfigured({
        providers: params.providers,
        providerId,
        cfg: params.cfg,
        agentDir: params.agentDir,
      }),
  });
}

export function resolveMediaToolLocalRoots(
  workspaceDirRaw: string | undefined,
  options?: { fsPolicy?: ToolFsPolicy; workspaceOnly?: boolean },
  _mediaSources?: readonly string[],
): string[] {
  const workspaceDir = normalizeWorkspaceDir(workspaceDirRaw) ?? undefined;
  const policy = options?.fsPolicy;

  // Back-compat: older call sites passed { workspaceOnly: true } directly.
  // Treat it as fsPolicy.workspaceOnly.
  const workspaceOnly =
    policy?.workspaceOnly === true || options?.workspaceOnly === true;

  // For workspace-only mode we must hard-limit roots to workspace.
  if (workspaceOnly) {
    return workspaceDir ? [workspaceDir] : [];
  }

  // For allow/deny policies with glob semantics, root filtering alone is insufficient.
  // Exact policy enforcement is applied per resolved file path in image/pdf tools via PathGuard.
  const defaultRoots = getDefaultLocalRoots();

  // Include allowlist directory roots so loadWebMedia doesn't reject before PathGuard.
  // Extract directory prefixes from allowedPaths glob patterns.
  const allowlistRoots: string[] = [];
  if (policy?.allowedPaths) {
    for (const pattern of policy.allowedPaths) {
      // For absolute paths, extract the directory prefix before any glob magic.
      // Use platform-aware check to support Windows paths (C:\...) and POSIX (/...).
      if (path.isAbsolute(pattern)) {
        // Find first glob-magic character and take the directory prefix.
        // Include extglob operators (!, +, @) when followed by '(' (e.g. @(foo|bar)).
        const firstMagic = (() => {
          // We only treat backslash as an escape when it escapes a glob magic
          // character. On Windows, backslash is also a path separator.
          const escapable = new Set([
            "*",
            "?",
            "[",
            "]",
            "{",
            "}",
            "(",
            ")",
            "!",
            "+",
            "@",
          ]);

          for (let i = 0; i < pattern.length; i += 1) {
            const ch = pattern[i];

            if (ch === "\\") {
              const next = pattern[i + 1];
              if (next && escapable.has(next)) {
                i += 1;
                continue;
              }
              // Otherwise it's likely a Windows path separator; do not skip.
              continue;
            }

            if (ch === "*" || ch === "?" || ch === "[" || ch === "{") {
              return i;
            }

            if (
              (ch === "!" || ch === "+" || ch === "@") &&
              pattern[i + 1] === "("
            ) {
              return i;
            }
          }
          return -1;
        })();

        if (firstMagic >= 0) {
          // Take the directory prefix (last path separator before magic)
          const lastSep = Math.max(
            pattern.lastIndexOf("/", firstMagic),
            pattern.lastIndexOf("\\", firstMagic),
          );
          if (lastSep >= 0) {
            // Preserve the root separator for drive-root patterns:
            // - "C:\\**\\*.pdf" -> "C:\\" (not "C:")
            // - "C:/**/**/*.pdf" -> "C:/" (not "C:")
            const driveRootSep =
              /^[A-Za-z]:/u.test(pattern) &&
              (pattern[2] === "\\" || pattern[2] === "/")
                ? 2
                : -1;
            if (lastSep === driveRootSep) {
              allowlistRoots.push(pattern.slice(0, 3));
            } else if (lastSep > 0) {
              allowlistRoots.push(pattern.slice(0, lastSep));
            } else {
              // lastSep == 0 -> rooted at filesystem root (POSIX '/')
              allowlistRoots.push(pattern.slice(0, 1));
            }
          }
        } else {
          // No glob magic - it's a literal path, use as-is
          allowlistRoots.push(pattern);
        }
      }
    }
  }

  return uniqueNormalized(
    workspaceDir
      ? [...defaultRoots, workspaceDir, ...allowlistRoots]
      : [...defaultRoots, ...allowlistRoots],
  );
}

export function resolvePromptAndModelOverride(
  args: Record<string, unknown>,
  defaultPrompt: string,
): {
  prompt: string;
  modelOverride?: string;
} {
  const prompt =
    typeof args.prompt === "string" && args.prompt.trim()
      ? args.prompt.trim()
      : defaultPrompt;
  const modelOverride =
    typeof args.model === "string" && args.model.trim()
      ? args.model.trim()
      : undefined;
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
  const model = params.modelRegistry.find(
    params.provider,
    params.modelId,
  ) as Model<Api> | null;
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
