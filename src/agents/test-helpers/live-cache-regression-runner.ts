import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { Type } from "typebox";
import type { AssistantMessage, Message, Tool } from "../../llm/types.js";
import { extractEmbeddedAssistantText } from "../embedded-agent-utils.js";
import {
  assertAgainstBaseline,
  type BaselineFindings,
  type CacheLane,
  type CacheRun,
  type CacheUsage,
  evaluateAgainstBaseline,
  isAnthropicToolProbeDrift,
  type LaneResult,
  LIVE_CACHE_RESPONSE_RETRIES,
  resolveCacheProbeMaxTokens,
  resolveLiveCacheProviderPool,
  shouldAcceptEmptyCacheProbe,
  shouldRetryBaselineFindings,
  shouldRetryCacheProbeText,
} from "../live-cache-regression-policy.js";
import {
  buildAssistantHistoryTurn,
  buildStableCachePrefix,
  completeSimpleWithLiveTimeout,
  computeCacheHitRate,
  type LiveResolvedModel,
  logLiveCache,
  withLiveDirectModelApiKey,
} from "../live-cache-test-support.js";
import { shouldSkipLiveProviderDrift } from "../live-test-provider-drift.js";

const CACHE_TIMEOUT_MS = 120_000;
const LIVE_CACHE_LANE_RETRIES = 1;
const OPENAI_CACHE_REASONING = "none" as unknown as never;
const OPENAI_PREFIX = buildStableCachePrefix("openai");
const OPENAI_MCP_PREFIX = buildStableCachePrefix("openai-mcp-style");
const ANTHROPIC_PREFIX = buildStableCachePrefix("anthropic");
const LIVE_TEST_PNG_URL = new URL(
  "../../../apps/android/app/src/main/res/mipmap-xhdpi/ic_launcher.png",
  import.meta.url,
);

type LiveCacheRegressionResult = BaselineFindings & {
  summary: Record<string, Record<string, unknown>>;
};
type CacheTurn = {
  apiKey: string;
  cacheRetention: "none" | "short" | "long";
  model: LiveResolvedModel["model"];
  providerTag: "anthropic" | "openai";
  sessionId: string;
  systemPrompt: string;
  messages: Message[];
  tools?: Tool[];
  maxTokens: number;
};
type CacheLaneContext = {
  lane: CacheLane;
  providerTag: CacheTurn["providerTag"];
  fixture: LiveResolvedModel;
  runToken: string;
  pngBase64: string;
};
class CacheProbeTextMismatchError extends Error {
  constructor(
    readonly suffix: string,
    readonly text: string,
  ) {
    super(`expected response to contain CACHE-OK ${suffix}, got ${JSON.stringify(text)}`);
  }
}

const NOOP_TOOL: Tool = {
  name: "noop",
  description: "Return ok.",
  parameters: Type.Object({}, { additionalProperties: false }),
};

const MCP_TOOL: Tool = {
  name: "bundleProbe__bundle_probe",
  description: "Return bundle MCP probe text.",
  parameters: Type.Object({}, { additionalProperties: false }),
};

function makeUserTurn(content: Extract<Message, { role: "user" }>["content"]): Message {
  return { role: "user", content, timestamp: Date.now() };
}

function normalizeCacheUsage(usage: AssistantMessage["usage"] | undefined): CacheUsage {
  const normalized: CacheUsage = {};
  for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    const value = usage?.[key];
    normalized[key] = typeof value === "number" ? value : undefined;
  }
  return normalized;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function completeCacheTurn(params: CacheTurn, label: string) {
  return completeSimpleWithLiveTimeout(
    params.model,
    {
      systemPrompt: params.systemPrompt,
      messages: params.messages,
      ...(params.tools ? { tools: params.tools } : {}),
    },
    {
      apiKey: params.apiKey,
      cacheRetention: params.cacheRetention,
      sessionId: params.sessionId,
      maxTokens: params.maxTokens,
      temperature: 0,
      ...(params.providerTag === "openai" ? { reasoning: OPENAI_CACHE_REASONING } : {}),
    },
    label,
    CACHE_TIMEOUT_MS,
  );
}

async function runToolOnlyTurn(
  params: Omit<CacheTurn, "messages" | "tools" | "maxTokens"> & { tool: Tool },
) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const prompt =
      attempt === 0
        ? `Call the tool \`${params.tool.name}\` with {}. IMPORTANT: respond ONLY with the tool call and no other text.`
        : `Return only a tool call for \`${params.tool.name}\` with {}. No text.`;
    const response = await completeCacheTurn(
      {
        ...params,
        messages: [makeUserTurn(prompt)],
        tools: [params.tool],
        maxTokens: 128,
      },
      `${params.providerTag} ${params.tool.name} tool-only ${attempt === 0 ? "turn" : `retry ${attempt}`}`,
    );
    const toolCall = response.content.find((block) => block.type === "toolCall");
    const text = extractEmbeddedAssistantText(response);
    if (attempt < 2 && (!toolCall || text.length > 0)) {
      continue;
    }
    assert(toolCall, `expected tool call for ${params.tool.name}`);
    assert(
      text.length === 0,
      `expected tool-only response for ${params.tool.name}, got ${JSON.stringify(text)}`,
    );
    return { prompt, response, toolCall };
  }
  throw new Error(`expected tool call for ${params.tool.name}`);
}

async function completeCacheProbe(
  params: Omit<CacheTurn, "maxTokens"> & { suffix: string; maxTokens?: number },
): Promise<CacheRun> {
  for (let attempt = 1; attempt <= 1 + LIVE_CACHE_RESPONSE_RETRIES; attempt += 1) {
    const response = await completeCacheTurn(
      {
        ...params,
        maxTokens: resolveCacheProbeMaxTokens({
          maxTokens: params.maxTokens,
          providerTag: params.providerTag,
        }),
      },
      `${params.providerTag} cache lane ${params.suffix}`,
    );
    const text = extractEmbeddedAssistantText(response);
    const usage = normalizeCacheUsage(response.usage);
    if (shouldAcceptEmptyCacheProbe({ providerTag: params.providerTag, text, usage })) {
      logLiveCache(
        `${params.providerTag} cache lane ${params.suffix} accepted empty text with usage ${formatUsage(usage)}`,
      );
    } else if (shouldRetryCacheProbeText({ attempt, suffix: params.suffix, text })) {
      logLiveCache(
        `${params.providerTag} cache lane ${params.suffix} response mismatch; retrying: ${JSON.stringify(text)} stop=${response.stopReason} error=${response.errorMessage ?? ""} ${formatUsage(usage)}`,
      );
      continue;
    } else if (
      !normalizeLowercaseStringOrEmpty(text).includes(
        `cache-ok ${normalizeLowercaseStringOrEmpty(params.suffix)}`,
      )
    ) {
      throw new CacheProbeTextMismatchError(params.suffix, text);
    }
    return {
      suffix: params.suffix,
      text,
      usage,
      hitRate: computeCacheHitRate(usage),
    };
  }
  throw new Error(`expected response to contain CACHE-OK ${params.suffix}`);
}

async function runRepeatedLane(
  params: CacheLaneContext & { sessionId: string },
): Promise<LaneResult> {
  const suffixBase = `${params.providerTag}-${params.lane}`;
  const systemPromptBase =
    params.providerTag === "openai"
      ? params.lane === "mcp"
        ? OPENAI_MCP_PREFIX
        : OPENAI_PREFIX
      : ANTHROPIC_PREFIX;
  const systemPrompt = `${systemPromptBase}\nRun token: ${params.runToken}\nLane: ${params.providerTag}-${params.lane}\n`;

  const common = {
    apiKey: params.fixture.apiKey,
    cacheRetention: "short" as const,
    model: params.fixture.model,
    providerTag: params.providerTag,
    sessionId: params.sessionId,
    systemPrompt,
  };
  const run = async (suffix: string) => {
    const history: Message[] = [];
    let tools: Tool[] | undefined;
    if (params.lane === "image") {
      history.push(
        makeUserTurn([
          {
            type: "text",
            text: "An image is attached. Ignore image semantics but keep the bytes in history.",
          },
          { type: "image", mimeType: "image/png", data: params.pngBase64 },
        ]),
        buildAssistantHistoryTurn("IMAGE HISTORY ACKNOWLEDGED", params.fixture.model),
        makeUserTurn("Keep the earlier image turn stable in context."),
        buildAssistantHistoryTurn("IMAGE HISTORY PRESERVED", params.fixture.model),
      );
    } else if (params.lane !== "stable") {
      const tool = params.lane === "mcp" ? MCP_TOOL : NOOP_TOOL;
      const toolText = params.lane === "mcp" ? "FROM-BUNDLE" : "ok";
      const historyPrefix = params.lane === "mcp" ? "MCP TOOL HISTORY" : "TOOL HISTORY";
      const toolTurn = await runToolOnlyTurn({ ...common, tool });
      tools = [tool];
      history.push(
        makeUserTurn(toolTurn.prompt),
        toolTurn.response,
        {
          role: "toolResult",
          toolCallId: toolTurn.toolCall.id,
          toolName: tool.name,
          content: [{ type: "text", text: toolText }],
          isError: false,
          timestamp: Date.now(),
        },
        buildAssistantHistoryTurn(`${historyPrefix} ACKNOWLEDGED`, params.fixture.model),
        makeUserTurn(
          params.lane === "mcp"
            ? "Keep the MCP tool output stable in history."
            : "Keep the tool output stable in history.",
        ),
        buildAssistantHistoryTurn(`${historyPrefix} PRESERVED`, params.fixture.model),
      );
    }
    return completeCacheProbe({
      ...common,
      suffix,
      messages: [...history, makeUserTurn(`Reply with exactly CACHE-OK ${suffix}.`)],
      ...(tools ? { tools } : {}),
      ...(params.lane === "stable" ? { maxTokens: 32 } : {}),
    });
  };

  const warmup = await run(`${suffixBase}-warmup`);
  const hitA = await run(`${suffixBase}-hit-a`);
  const hitB = await run(`${suffixBase}-hit-b`);
  // Keep the stronger hit sample; live provider cache accounting can vary by call.
  const best = (hitA.usage.cacheRead ?? 0) >= (hitB.usage.cacheRead ?? 0) ? hitA : hitB;
  return { best, warmup };
}

function formatUsage(usage: CacheUsage | undefined) {
  return `cacheRead=${usage?.cacheRead ?? 0} cacheWrite=${usage?.cacheWrite ?? 0} input=${usage?.input ?? 0} output=${usage?.output ?? 0}`;
}

async function runRepeatedLaneWithBaselineRetry(
  params: CacheLaneContext,
): Promise<{ result: LaneResult; findings: BaselineFindings; attempts: number }> {
  for (let attempt = 1; attempt <= 1 + LIVE_CACHE_LANE_RETRIES; attempt += 1) {
    let result: LaneResult;
    try {
      result = await runRepeatedLane({
        ...params,
        sessionId: `live-cache-regression-${params.runToken}-${params.providerTag}-${params.lane}${
          attempt > 1 ? `-retry-${attempt}` : ""
        }`,
      });
    } catch (error) {
      if (error instanceof CacheProbeTextMismatchError && attempt <= LIVE_CACHE_LANE_RETRIES) {
        // Retry a whole lane once so response-text drift does not hide cache regressions.
        logLiveCache(
          `${params.providerTag} ${params.lane} response mismatch; retrying lane once: ${error.message}`,
        );
        continue;
      }
      throw error;
    }
    const findings = evaluateAgainstBaseline({
      lane: params.lane,
      provider: params.providerTag,
      result,
    });
    if (!shouldRetryBaselineFindings(findings, attempt)) {
      return { result, findings, attempts: attempt };
    }
    logLiveCache(
      `${params.providerTag} ${params.lane} baseline miss; retrying lane once: ${JSON.stringify(
        findings.regressions,
      )}`,
    );
  }

  throw new Error(`expected ${params.providerTag} ${params.lane} cache lane result`);
}

function shouldSkipAnthropicCacheProviderDrift(error: unknown): boolean {
  return Boolean(shouldSkipLiveProviderDrift({ error, allowAuth: true, allowBilling: true }));
}

function recordAnthropicDrift(
  error: unknown,
  lane: CacheLane | "disabled",
  warnings: string[],
): boolean {
  const empty = error instanceof CacheProbeTextMismatchError && error.text.trim().length === 0;
  const toolDrift = lane !== "disabled" && isAnthropicToolProbeDrift(error);
  if (!shouldSkipAnthropicCacheProviderDrift(error) && !empty && !toolDrift) {
    return false;
  }
  const reason =
    empty && lane !== "disabled"
      ? "empty response"
      : toolDrift
        ? "tool probe drift"
        : "account drift";
  const warning = `anthropic ${lane} skipped: ${reason}`;
  warnings.push(warning);
  logLiveCache(warning);
  return true;
}

async function runAnthropicCacheLane(
  params: Omit<CacheLaneContext, "providerTag"> & {
    apiKeys: readonly string[];
    warnings: string[];
  },
): Promise<Awaited<ReturnType<typeof runRepeatedLaneWithBaselineRetry>> | undefined> {
  const keys = params.apiKeys.length > 0 ? params.apiKeys : [params.fixture.apiKey];
  let lastError: unknown;
  for (const [index, apiKey] of keys.entries()) {
    try {
      return await runRepeatedLaneWithBaselineRetry({
        lane: params.lane,
        providerTag: "anthropic",
        fixture: withLiveDirectModelApiKey(params.fixture, apiKey),
        runToken: params.runToken,
        pngBase64: params.pngBase64,
      });
    } catch (error) {
      lastError = error;
      if (shouldSkipAnthropicCacheProviderDrift(error) && index + 1 < keys.length) {
        // Anthropic keys can drift independently; try the next live key before skipping.
        logLiveCache(`anthropic ${params.lane} account drift; retrying with next key`);
        continue;
      }
      break;
    }
  }

  if (recordAnthropicDrift(lastError, params.lane, params.warnings)) {
    return undefined;
  }
  throw lastError;
}

async function runAnthropicDisabledCacheLane(params: {
  fixture: LiveResolvedModel;
  runToken: string;
  warnings: string[];
}): Promise<LaneResult | undefined> {
  try {
    return {
      disabled: await completeCacheProbe({
        apiKey: params.fixture.apiKey,
        cacheRetention: "none",
        messages: [makeUserTurn("Reply with exactly CACHE-OK anthropic-disabled.")],
        model: params.fixture.model,
        providerTag: "anthropic",
        sessionId: `live-cache-regression-${params.runToken}-anthropic-disabled`,
        suffix: "anthropic-disabled",
        systemPrompt: `${ANTHROPIC_PREFIX}\nRun token: ${params.runToken}\nLane: anthropic-disabled\n`,
        maxTokens: 32,
      }),
    };
  } catch (error) {
    if (recordAnthropicDrift(error, "disabled", params.warnings)) {
      return undefined;
    }
    throw error;
  }
}

/** Runs all live prompt-cache lanes and returns hard regressions plus warn-only drift. */
export async function runLiveCacheRegression(): Promise<LiveCacheRegressionResult> {
  const pngBase64 = (await fs.readFile(LIVE_TEST_PNG_URL)).toString("base64");
  const runToken = randomUUID().slice(0, 13);
  const regressions: string[] = [];
  const warnings: string[] = [];
  const summary: Record<CacheTurn["providerTag"], Record<string, unknown>> = {
    anthropic: {},
    openai: {},
  };
  const recordLane = (
    provider: "openai" | "anthropic",
    lane: CacheLane,
    attempt?: Awaited<ReturnType<typeof runRepeatedLaneWithBaselineRetry>>,
  ) => {
    const target = summary[provider];
    if (!attempt) {
      target[lane] = { skipped: true };
      return;
    }
    const { result, attempts, findings } = attempt;
    for (const sample of ["warmup", "best"] as const) {
      logLiveCache(
        `${provider} ${lane} ${sample} ${formatUsage(result[sample]?.usage ?? {})} rate=${result[sample]?.hitRate.toFixed(3) ?? "0.000"}`,
      );
    }
    target[lane] = {
      best: result.best?.usage,
      hitRate: result.best?.hitRate,
      attempts,
      warmup: result.warmup?.usage,
    };
    regressions.push(...findings.regressions);
    warnings.push(...findings.warnings);
  };
  const resolvePool = (config: Parameters<typeof resolveLiveCacheProviderPool>[0]["config"]) =>
    resolveLiveCacheProviderPool({ config, regressions, summary, warnings });
  const openai = await resolvePool({
    provider: "openai",
    api: "openai-responses",
    envVar: "OPENCLAW_LIVE_OPENAI_CACHE_MODEL",
    preferredModelIds: ["gpt-5.6-luna", "gpt-5.5", "gpt-5.4-mini", "gpt-5.4"],
  });
  const anthropic = await resolvePool({
    provider: "anthropic",
    api: "anthropic-messages",
    envVar: "OPENCLAW_LIVE_ANTHROPIC_CACHE_MODEL",
    preferredModelIds: ["claude-sonnet-5", "claude-haiku-4-5"],
  });

  for (const lane of ["stable", "tool", "image", "mcp"] as const) {
    for (const [provider, pool] of [
      ["openai", openai],
      ["anthropic", anthropic],
    ] as const) {
      let attempt: Awaited<ReturnType<typeof runRepeatedLaneWithBaselineRetry>> | undefined;
      if (pool) {
        const context = { lane, fixture: pool.fixture, runToken, pngBase64 };
        attempt =
          provider === "openai"
            ? await runRepeatedLaneWithBaselineRetry({ ...context, providerTag: provider })
            : await runAnthropicCacheLane({ ...context, apiKeys: pool.apiKeys, warnings });
      }
      recordLane(provider, lane, attempt);
    }
  }

  const disabled = anthropic
    ? await runAnthropicDisabledCacheLane({
        fixture: anthropic.fixture,
        runToken,
        warnings,
      })
    : undefined;
  if (disabled) {
    logLiveCache(`anthropic disabled ${formatUsage(disabled.disabled?.usage ?? {})}`);
    summary.anthropic.disabled = {
      disabled: disabled.disabled?.usage,
    };
    assertAgainstBaseline({
      lane: "disabled",
      provider: "anthropic",
      result: disabled,
      regressions,
      warnings,
    });
  } else {
    summary.anthropic.disabled = { skipped: true };
  }

  logLiveCache(`cache regression summary ${JSON.stringify(summary)}`);
  if (warnings.length > 0) {
    logLiveCache(`cache regression warnings ${JSON.stringify(warnings)}`);
  }
  return { regressions, summary, warnings };
}
