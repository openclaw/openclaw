import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AssistantMessageEventStream } from "@mariozechner/pi-ai";
import {
  createAssistantMessageEventStream,
  getEnvApiKey,
  registerApiProvider,
  supportsXhigh,
} from "@mariozechner/pi-ai";
import {
  convertResponsesMessages,
  convertResponsesTools,
  processResponsesStream,
} from "./vida-responses-shared.js";

const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
const VALID_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "none"]);

function resolveCacheRetention(cacheRetention?: string): string {
  if (cacheRetention) {
    return cacheRetention;
  }
  if (typeof process !== "undefined" && process.env.PI_CACHE_RETENTION === "long") {
    return "long";
  }
  return "short";
}

function getPromptCacheRetention(baseUrl: string, cacheRetention: string): string | undefined {
  if (cacheRetention !== "long") {
    return undefined;
  }
  if (baseUrl.includes("api.openai.com")) {
    return "24h";
  }
  return undefined;
}

export const streamVidaResponses = (
  model: any,
  context: any,
  options?: any,
): AssistantMessageEventStream => {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    const output: any = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    try {
      const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
      const client = await createClient(model, context, apiKey, options?.headers);
      const params = buildParams(model, context, options);
      options?.onPayload?.(params);
      const openaiStream = await client.responses.create(
        params,
        options?.signal ? { signal: options.signal } : undefined,
      );
      stream.push({ type: "start", partial: output });
      await processResponsesStream(openaiStream, output, stream, model, {
        serviceTier: options?.serviceTier,
        applyServiceTierPricing,
      });
      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }
      if (output.stopReason === "aborted" || output.stopReason === "error") {
        throw new Error("An unknown error occurred");
      }
      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      for (const block of output.content) {
        delete block.index;
      }
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();
  return stream;
};

export const streamSimpleVidaResponses = (
  model: any,
  context: any,
  options?: any,
): AssistantMessageEventStream => {
  const apiKey = options?.apiKey || getEnvApiKey(model.provider);
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }
  const base = buildBaseOptions(model, options, apiKey);
  const reasoningEffort = supportsXhigh(model)
    ? options?.reasoning
    : clampReasoning(options?.reasoning);
  return streamVidaResponses(model, context, {
    ...base,
    reasoningEffort,
  });
};

async function createClient(
  model: any,
  context: any,
  apiKey: string,
  optionsHeaders?: Record<string, string>,
): Promise<any> {
  if (!apiKey) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error(
        "OpenAI API key is required. Set OPENAI_API_KEY environment variable or pass it as an argument.",
      );
    }
    apiKey = process.env.OPENAI_API_KEY;
  }
  const headers: Record<string, string> = { ...model.headers };
  if (model.provider === "github-copilot") {
    const messages = context.messages || [];
    const lastMessage = messages[messages.length - 1];
    const isAgentCall = lastMessage ? lastMessage.role !== "user" : false;
    headers["X-Initiator"] = isAgentCall ? "agent" : "user";
    headers["Openai-Intent"] = "conversation-edits";
    const hasImages = messages.some((msg: any) => {
      if (msg.role === "user" && Array.isArray(msg.content)) {
        return msg.content.some((c: any) => c.type === "image");
      }
      if (msg.role === "toolResult" && Array.isArray(msg.content)) {
        return msg.content.some((c: any) => c.type === "image");
      }
      return false;
    });
    if (hasImages) {
      headers["Copilot-Vision-Request"] = "true";
    }
  }
  if (optionsHeaders) {
    Object.assign(headers, optionsHeaders);
  }
  const OpenAI = await loadOpenAIClient();
  return new OpenAI({
    apiKey,
    baseURL: model.baseUrl,
    dangerouslyAllowBrowser: true,
    defaultHeaders: headers,
  });
}

async function loadOpenAIClient(): Promise<any> {
  const require = createRequire(import.meta.url);
  const resolved = await resolveOpenAIClientPath(require, (specifier) =>
    import.meta.resolve(specifier),
  );
  const mod = await import(resolved);
  return mod.default ?? mod;
}

type ModuleResolver = Pick<NodeJS.Require, "resolve">;

async function resolveOpenAIClientPath(
  require: ModuleResolver,
  resolveImport: (specifier: string) => string | Promise<string>,
): Promise<string> {
  try {
    return require.resolve("openai");
  } catch {
    const piAiEntryUrl = await resolveImport("@mariozechner/pi-ai");
    const piAiEntry = normalizeResolvedPath(piAiEntryUrl);
    const piAiRoot = resolvePackageRootFromEntry(piAiEntry, "@mariozechner/pi-ai");
    return require.resolve("openai", { paths: [piAiRoot] });
  }
}

function normalizeResolvedPath(value: string): string {
  if (value.startsWith("file://")) {
    return fileURLToPath(value);
  }
  return value;
}

function resolvePackageRootFromEntry(entryPath: string, packageName: string): string {
  let current = path.dirname(entryPath);
  while (true) {
    const packageJsonPath = path.join(current, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      try {
        const raw = fs.readFileSync(packageJsonPath, "utf8");
        const pkg = JSON.parse(raw) as { name?: unknown };
        if (pkg.name === packageName) {
          return current;
        }
      } catch {
        // Ignore parse/read failures while walking upward.
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Unable to resolve package root for ${packageName} from ${entryPath}`);
    }
    current = parent;
  }
}

function buildParams(model: any, context: any, options?: any): any {
  const messages = convertResponsesMessages(model, context, OPENAI_TOOL_CALL_PROVIDERS);
  const cacheRetention = resolveCacheRetention(options?.cacheRetention);
  const relayMetadata = resolveRelayProviderMetadata(context, options);
  const params: any = {
    model: model.id,
    input: messages,
    stream: true,
    prompt_cache_key: cacheRetention === "none" ? undefined : options?.sessionId,
    prompt_cache_retention: getPromptCacheRetention(model.baseUrl, cacheRetention),
  };
  if (options?.maxTokens) {
    params.max_output_tokens = options?.maxTokens;
  }
  if (options?.temperature !== undefined) {
    params.temperature = options?.temperature;
  }
  if (options?.serviceTier !== undefined) {
    params.service_tier = options.serviceTier;
  }
  if (context.tools) {
    params.tools = convertResponsesTools(context.tools);
  }
  if (relayMetadata) {
    params.provider_metadata = relayMetadata;
    if (hasVidaRelayFlag(relayMetadata)) {
      params.metadata = {
        ...(params.metadata && typeof params.metadata === "object" ? params.metadata : {}),
        "vida.ignoreOnProviderRelay": "true",
      };
    }
  }
  const metadataReasoningEffort = resolveRelayReasoningEffort(relayMetadata, model);
  const effectiveReasoningEffort = metadataReasoningEffort ?? options?.reasoningEffort;
  if (model.reasoning) {
    if (effectiveReasoningEffort === "none") {
      // Explicit no-thinking override: do not send a reasoning block.
    } else if (effectiveReasoningEffort || options?.reasoningSummary) {
      params.reasoning = {
        effort: effectiveReasoningEffort || "medium",
        summary: options?.reasoningSummary || "auto",
      };
      params.include = ["reasoning.encrypted_content"];
    } else {
      if (model.name.startsWith("gpt-5")) {
        messages.push({
          role: "developer",
          content: [
            {
              type: "input_text",
              text: "# Juice: 0 !important",
            },
          ],
        });
      }
    }
  }
  return params;
}

/** @internal Exported for provider payload tests. */
export function buildVidaResponsesParamsForTest(model: any, context: any, options?: any): any {
  return buildParams(model, context, options);
}

/** @internal Exported for provider resolution tests. */
export function resolveVidaResponsesOpenAIPathForTest(
  require: ModuleResolver,
  resolveImport: (specifier: string) => string | Promise<string>,
): Promise<string> {
  return resolveOpenAIClientPath(require, resolveImport);
}

function getServiceTierCostMultiplier(serviceTier?: string): number {
  switch (serviceTier) {
    case "flex":
      return 0.5;
    case "priority":
      return 2;
    default:
      return 1;
  }
}

function applyServiceTierPricing(usage: any, serviceTier?: string): void {
  const multiplier = getServiceTierCostMultiplier(serviceTier);
  if (multiplier === 1) {
    return;
  }
  usage.cost.input *= multiplier;
  usage.cost.output *= multiplier;
  usage.cost.cacheRead *= multiplier;
  usage.cost.cacheWrite *= multiplier;
  usage.cost.total =
    usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

function buildBaseOptions(model: any, options: any, apiKey: string): any {
  return {
    temperature: options?.temperature,
    maxTokens: options?.maxTokens || Math.min(model.maxTokens, 32000),
    signal: options?.signal,
    apiKey: apiKey || options?.apiKey,
    cacheRetention: options?.cacheRetention,
    sessionId: options?.sessionId,
    headers: options?.headers,
    onPayload: options?.onPayload,
    maxRetryDelayMs: options?.maxRetryDelayMs,
  };
}

function clampReasoning(effort?: string): string | undefined {
  return effort === "xhigh" ? "high" : effort;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function normalizeReasoningEffort(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    return undefined;
  }
  return normalized;
}

function resolveRelayProviderMetadata(
  context: any,
  options?: any,
): Record<string, unknown> | undefined {
  const explicit = asRecord(options?.providerMetadata);
  if (explicit && Object.keys(explicit).length > 0) {
    return explicit;
  }
  const messages = Array.isArray(context?.messages) ? context.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = asRecord(messages[i]);
    const messageMetadata = asRecord(message?.providerMetadata);
    if (messageMetadata && Object.keys(messageMetadata).length > 0) {
      return messageMetadata;
    }
    const parts = Array.isArray(message?.content) ? message.content : [];
    for (let j = parts.length - 1; j >= 0; j -= 1) {
      const part = asRecord(parts[j]);
      const partMetadata = asRecord(part?.providerMetadata);
      if (partMetadata && Object.keys(partMetadata).length > 0) {
        return partMetadata;
      }
    }
  }
  return undefined;
}

function hasVidaRelayFlag(metadata: Record<string, unknown>): boolean {
  const direct = metadata["vida.ignoreOnProviderRelay"];
  if (direct === true || direct === "true" || direct === 1 || direct === "1") {
    return true;
  }
  const vida = asRecord(metadata.vida);
  const nested = vida?.ignoreOnProviderRelay;
  return nested === true || nested === "true" || nested === 1 || nested === "1";
}

function resolveRelayReasoningEffort(
  metadata: Record<string, unknown> | undefined,
  model: any,
): string | undefined {
  const vida = asRecord(metadata?.vida);
  const rawEffort = normalizeReasoningEffort(vida?.reasoningEffort);
  if (!rawEffort) {
    return undefined;
  }
  if (supportsXhigh(model)) {
    return rawEffort;
  }
  return clampReasoning(rawEffort);
}

let registered = false;

export function registerVidaResponsesProvider(): void {
  if (registered) {
    return;
  }
  registerApiProvider(
    {
      api: "vida-responses",
      stream: streamVidaResponses,
      streamSimple: streamSimpleVidaResponses,
    },
    "openclaw:vida-responses",
  );
  registered = true;
}

registerVidaResponsesProvider();
