import { Type } from "@sinclair/typebox";
import {
  buildXaiCodeExecutionPayload,
  requestXaiCodeExecution,
  resolveXaiCodeExecutionMaxTurns,
  resolveXaiCodeExecutionModel,
} from "../../../extensions/xai/src/code-execution-shared.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveProviderWebSearchPluginConfig } from "../../plugin-sdk/provider-web-search.js";
import { jsonResult, readStringParam } from "./common.js";
import { readConfiguredSecretString, readProviderEnvValue } from "./web-search-provider-common.js";

type CodeExecutionConfig =
  NonNullable<OpenClawConfig["tools"]> extends infer Tools
    ? Tools extends { code_execution?: infer CodeExecution }
      ? CodeExecution
      : undefined
    : undefined;

function readLegacyGrokApiKey(cfg?: OpenClawConfig): string | undefined {
  const search = cfg?.tools?.web?.search;
  if (!search || typeof search !== "object") {
    return undefined;
  }
  const grok = (search as Record<string, unknown>).grok;
  return readConfiguredSecretString(
    grok && typeof grok === "object" ? (grok as Record<string, unknown>).apiKey : undefined,
    "tools.web.search.grok.apiKey",
  );
}

function readPluginXaiWebSearchApiKey(cfg?: OpenClawConfig): string | undefined {
  return readConfiguredSecretString(
    resolveProviderWebSearchPluginConfig(cfg as Record<string, unknown> | undefined, "xai")?.apiKey,
    "plugins.entries.xai.config.webSearch.apiKey",
  );
}

function resolveFallbackXaiApiKey(cfg?: OpenClawConfig): string | undefined {
  return readPluginXaiWebSearchApiKey(cfg) ?? readLegacyGrokApiKey(cfg);
}

function resolveCodeExecutionConfig(cfg?: OpenClawConfig): CodeExecutionConfig | undefined {
  const codeExecution = cfg?.tools?.code_execution;
  if (!codeExecution || typeof codeExecution !== "object") {
    return undefined;
  }
  return codeExecution;
}

function resolveCodeExecutionEnabled(params: {
  cfg?: OpenClawConfig;
  config?: CodeExecutionConfig;
}): boolean {
  if (params.config?.enabled === false) {
    return false;
  }
  const configuredApiKey = readConfiguredSecretString(
    params.config?.apiKey,
    "tools.code_execution.apiKey",
  );
  return Boolean(
    configuredApiKey ||
    resolveFallbackXaiApiKey(params.cfg) ||
    readProviderEnvValue(["XAI_API_KEY"]),
  );
}

function resolveCodeExecutionApiKey(
  config?: CodeExecutionConfig,
  cfg?: OpenClawConfig,
): string | undefined {
  return (
    readConfiguredSecretString(config?.apiKey, "tools.code_execution.apiKey") ??
    resolveFallbackXaiApiKey(cfg) ??
    readProviderEnvValue(["XAI_API_KEY"])
  );
}

export function createCodeExecutionTool(options?: { config?: OpenClawConfig }) {
  const codeExecutionConfig = resolveCodeExecutionConfig(options?.config);
  if (!resolveCodeExecutionEnabled({ cfg: options?.config, config: codeExecutionConfig })) {
    return null;
  }

  return {
    label: "Code Execution",
    name: "code_execution",
    description:
      "Run sandboxed Python analysis with xAI. Use for calculations, tabulation, summaries, and chart-style analysis without local machine access.",
    parameters: Type.Object({
      task: Type.String({
        description:
          "The full analysis task for xAI's remote Python sandbox. Include any data to analyze directly in the task.",
      }),
    }),
    execute: async (_toolCallId: string, args: Record<string, unknown>) => {
      const apiKey = resolveCodeExecutionApiKey(codeExecutionConfig, options?.config);
      if (!apiKey) {
        return jsonResult({
          error: "missing_xai_api_key",
          message:
            "code_execution needs an xAI API key. Set XAI_API_KEY in the Gateway environment, or configure tools.code_execution.apiKey or plugins.entries.xai.config.webSearch.apiKey.",
          docs: "https://docs.openclaw.ai/tools/code-execution",
        });
      }

      const task = readStringParam(args, "task", { required: true });
      const codeExecutionConfigRecord = codeExecutionConfig as Record<string, unknown> | undefined;
      const model = resolveXaiCodeExecutionModel(codeExecutionConfigRecord);
      const maxTurns = resolveXaiCodeExecutionMaxTurns(codeExecutionConfigRecord);
      const startedAt = Date.now();
      const result = await requestXaiCodeExecution({
        apiKey,
        model,
        timeoutSeconds: codeExecutionConfig?.timeoutSeconds ?? 30,
        maxTurns,
        task,
      });
      return jsonResult(
        buildXaiCodeExecutionPayload({
          task,
          model,
          tookMs: Date.now() - startedAt,
          content: result.content,
          citations: result.citations,
          usedCodeExecution: result.usedCodeExecution,
          outputTypes: result.outputTypes,
        }),
      );
    },
  };
}
