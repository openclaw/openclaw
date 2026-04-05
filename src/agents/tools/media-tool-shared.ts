import path from "node:path";
import { type Api, type Model } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../config/config.js";
import { getDefaultLocalRoots } from "../../media/web-media.js";
import type { ToolFsPolicy } from "../tool-fs-policy.js";
import type { ImageModelConfig } from "./image-tool.helpers.js";
import type { ToolModelConfig } from "./model-config.helpers.js";
import {
  getApiKeyForModel,
  normalizeWorkspaceDir,
  requireApiKey,
} from "./tool-runtime.helpers.js";

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

function applyAgentDefaultModelConfig(
  cfg: OpenClawConfig | undefined,
  key: "imageModel" | "imageGenerationModel" | "videoGenerationModel",
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

function uniqueNormalized(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of paths) {
    const normalized = path.resolve(candidate);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
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
