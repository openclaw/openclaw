import type { OpenClawConfig } from "../../../config/config.js";
import { logVerbose } from "../../../globals.js";
import type { ReplyPayload } from "../../types.js";
import { resolveQueueArbitratorProvider } from "../queue/model-arbitrator.js";
import {
  prepareSupervisorMilestonePrompt,
  type SupervisorMilestoneConsumptionInput,
} from "./milestone-consumer.js";
import type {
  SupervisorMilestonePreparedOutcomePayload,
  SupervisorMilestonePreparedPrompt,
  SupervisorMilestoneSkippedOutcomePayload,
  SupervisorMilestoneRuntimeEnvelope,
  SupervisorMilestoneRuntimeRequest,
} from "./types.js";

const DEFAULT_LMSTUDIO_BASE_URL = "http://127.0.0.1:1234";
const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_TIMEOUT_MS = 900;
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_LMSTUDIO_MODEL = "qwen3-1.7b-instruct";
const DEFAULT_OLLAMA_MODEL = "qwen3:1.7b";

type OpenAiChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
};

type OllamaGenerateResponse = {
  response?: string;
};

export type SupervisorMilestoneRuntimePreparationResult =
  | {
      ready: false;
      reason: string;
      prompt?: SupervisorMilestonePreparedPrompt;
      runtimeEnvelope?: SupervisorMilestoneRuntimeEnvelope;
      runtimeRequest?: SupervisorMilestoneRuntimeRequest;
    }
  | {
      ready: true;
      prompt: SupervisorMilestonePreparedPrompt;
      runtimeEnvelope: SupervisorMilestoneRuntimeEnvelope;
      runtimeRequest: SupervisorMilestoneRuntimeRequest;
    };

export type SupervisorMilestoneRuntimeResult =
  | {
      emitted: false;
      reason: string;
    }
  | {
      emitted: true;
      payload: ReplyPayload;
    };

export type SupervisorMilestoneRuntime = {
  generate(
    request: SupervisorMilestoneRuntimeRequest,
    options?: { abortSignal?: AbortSignal },
  ): Promise<SupervisorMilestoneRuntimeResult>;
};

function stripThinkingEnvelope(raw: string): string {
  return raw.replace(/<think>[\s\S]*?<\/think>\s*/gi, "").trim();
}

function extractOpenAiContent(payload: OpenAiChatCompletionResponse): string | undefined {
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (part.type === "text" ? part.text : undefined))
      .filter((value): value is string => Boolean(value))
      .join("")
      .trim();
  }
  return undefined;
}

function cleanMilestoneText(raw: string): string | undefined {
  const normalized = stripThinkingEnvelope(raw)
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || undefined;
}

function applyModelPromptDirectives(prompt: string, model: string): string {
  if (model.toLowerCase().includes("qwen")) {
    return `${prompt}\n/no_think`;
  }
  return prompt;
}

function buildSupervisorMilestoneRuntimeRequest(
  runtimeEnvelope: SupervisorMilestoneRuntimeEnvelope,
): SupervisorMilestoneRuntimeRequest {
  return {
    kind: "supervisor_milestone",
    prompt_slots: runtimeEnvelope.prompt_slots,
    planner: runtimeEnvelope.planner,
  };
}

function buildMilestonePrompt(request: SupervisorMilestoneRuntimeRequest): string {
  return [
    "请生成一条中文中间进展消息。",
    "目标：让用户舒服地知道任务出现了值得知道的中间进展。",
    "要求：",
    "- 只输出一句自然中文，不要 JSON，不要 markdown，不要引号。",
    "- 长度尽量控制在 14 到 32 个汉字。",
    "- 不要说“我正在处理”“请稍等”“收到”。",
    "- 不要重复 status 式控制语句，要写成真正有信息量的中间进展。",
    "- 不要承诺未完成的最终结果。",
    `用户心里的问题：${request.prompt_slots.audience_question}`,
    `语义角色：${request.prompt_slots.semantic_role}`,
    `提示：${request.prompt_slots.prompt_hint}`,
  ].join("\n");
}

function createModelBackedSupervisorMilestoneRuntime(params: {
  provider: "lmstudio" | "ollama";
  baseUrl: string;
  model: string;
  timeoutMs: number;
  temperature: number;
}): SupervisorMilestoneRuntime {
  return {
    async generate(request, options): Promise<SupervisorMilestoneRuntimeResult> {
      const prompt = applyModelPromptDirectives(buildMilestonePrompt(request), params.model);
      try {
        if (params.provider === "lmstudio") {
          const response = await fetch(
            `${params.baseUrl.replace(/\/+$/, "")}/v1/chat/completions`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                model: params.model,
                temperature: params.temperature,
                max_tokens: 128,
                messages: [
                  {
                    role: "system",
                    content:
                      "你为聊天助手生成一条单句中文 milestone。只输出最终文案，不要思考过程，不要 markdown。",
                  },
                  { role: "user", content: prompt },
                ],
              }),
              signal: options?.abortSignal
                ? AbortSignal.any([options.abortSignal, AbortSignal.timeout(params.timeoutMs)])
                : AbortSignal.timeout(params.timeoutMs),
            },
          );
          if (!response.ok) {
            return {
              emitted: false,
              reason: `lmstudio_status_${response.status}`,
            };
          }
          const raw = extractOpenAiContent((await response.json()) as OpenAiChatCompletionResponse);
          const text = raw ? cleanMilestoneText(raw) : undefined;
          return text
            ? { emitted: true, payload: { text } }
            : { emitted: false, reason: "empty_milestone_text" };
        }

        const response = await fetch(`${params.baseUrl.replace(/\/+$/, "")}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: params.model,
            prompt,
            stream: false,
            options: { temperature: params.temperature, num_predict: 128 },
          }),
          signal: options?.abortSignal
            ? AbortSignal.any([options.abortSignal, AbortSignal.timeout(params.timeoutMs)])
            : AbortSignal.timeout(params.timeoutMs),
        });
        if (!response.ok) {
          return {
            emitted: false,
            reason: `ollama_status_${response.status}`,
          };
        }
        const raw = ((await response.json()) as OllamaGenerateResponse).response?.trim();
        const text = raw ? cleanMilestoneText(raw) : undefined;
        return text
          ? { emitted: true, payload: { text } }
          : { emitted: false, reason: "empty_milestone_text" };
      } catch (error) {
        return {
          emitted: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

export function resolveSupervisorMilestoneRuntime(params: {
  cfg: OpenClawConfig;
}): SupervisorMilestoneRuntime | undefined {
  const provider = resolveQueueArbitratorProvider(params.cfg);
  const arbitratorCfg = params.cfg.messages?.queue?.arbitrator;
  if (!provider || !arbitratorCfg?.enabled) {
    return undefined;
  }

  return createModelBackedSupervisorMilestoneRuntime({
    provider,
    baseUrl:
      arbitratorCfg.baseUrl ??
      (provider === "ollama" ? DEFAULT_OLLAMA_BASE_URL : DEFAULT_LMSTUDIO_BASE_URL),
    model:
      arbitratorCfg.model ??
      (provider === "ollama" ? DEFAULT_OLLAMA_MODEL : DEFAULT_LMSTUDIO_MODEL),
    timeoutMs: arbitratorCfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    temperature: arbitratorCfg.temperature ?? DEFAULT_TEMPERATURE,
  });
}

/**
 * Converts planner-owned milestone semantics into the stable request shape a
 * future runtime can consume directly, without needing access to the planner.
 */
export function prepareSupervisorMilestoneRuntimeRequest(
  input: SupervisorMilestoneConsumptionInput,
): SupervisorMilestoneRuntimePreparationResult {
  const prepared = prepareSupervisorMilestonePrompt(input);
  if (!prepared.prepared) {
    const runtimeRequest = prepared.runtimeEnvelope
      ? buildSupervisorMilestoneRuntimeRequest(prepared.runtimeEnvelope)
      : undefined;
    return {
      ready: false,
      reason: prepared.reason,
      prompt: prepared.prompt,
      runtimeEnvelope: prepared.runtimeEnvelope,
      runtimeRequest,
    };
  }

  return {
    ready: true,
    prompt: prepared.prompt,
    runtimeEnvelope: prepared.runtimeEnvelope,
    runtimeRequest: buildSupervisorMilestoneRuntimeRequest(prepared.runtimeEnvelope),
  };
}

export function buildSupervisorMilestoneOutcomePayload(
  result: SupervisorMilestoneRuntimePreparationResult,
): SupervisorMilestonePreparedOutcomePayload | SupervisorMilestoneSkippedOutcomePayload {
  if (!result.ready) {
    return {
      reason: result.reason,
      prompt: result.prompt,
      runtimeEnvelope: result.runtimeEnvelope,
      runtimeRequest: result.runtimeRequest,
    };
  }
  return {
    prompt: result.prompt,
    runtimeEnvelope: result.runtimeEnvelope,
    runtimeRequest: result.runtimeRequest,
  };
}

export async function generateSupervisorMilestonePayload(params: {
  runtime: SupervisorMilestoneRuntime | undefined;
  request: SupervisorMilestoneRuntimeRequest;
  abortSignal?: AbortSignal;
}): Promise<SupervisorMilestoneRuntimeResult> {
  if (!params.runtime) {
    return {
      emitted: false,
      reason: "milestone_runtime_unavailable",
    };
  }
  const result = await params.runtime.generate(params.request, {
    abortSignal: params.abortSignal,
  });
  if (!result.emitted) {
    logVerbose(`supervisor: milestone runtime skipped: ${result.reason}`);
  }
  return result;
}
