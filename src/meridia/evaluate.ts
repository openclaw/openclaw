import { type Api, completeSimple, type Model } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../config/config.js";
import type { MeridiaEvaluation, MeridiaToolResultContext } from "./types.js";
import { resolveOpenClawAgentDir } from "../agents/agent-paths.js";
import { getCustomProviderApiKey, resolveApiKeyForProvider } from "../agents/model-auth.js";
import {
  buildModelAliasIndex,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from "../agents/model-selection.js";
import { ensureOpenClawModelsJson } from "../agents/models-config.js";
import { resolveModel } from "../agents/pi-embedded-runner/model.js";

function clamp01(value: number): number {
  if (value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return value;
}

function summarize(value: unknown, maxChars: number): string {
  if (value === undefined) {
    return "";
  }
  let raw = "";
  try {
    raw = JSON.stringify(value);
  } catch {
    raw = String(value);
  }
  if (raw.length <= maxChars) {
    return raw;
  }
  return `${raw.slice(0, Math.max(0, maxChars - 12))}…(truncated)`;
}

function extractFirstJsonObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  const slice = raw.slice(start, end + 1);
  try {
    return JSON.parse(slice) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function evaluateHeuristic(ctx: MeridiaToolResultContext): MeridiaEvaluation {
  const tool = ctx.toolName.trim().toLowerCase();
  const isError = ctx.isError;
  let score = 0.1;
  let reason = "default";

  if (isError) {
    score = 0.55;
    reason = "tool_error";
  }

  if (tool === "exec" || tool === "bash") {
    score = Math.max(score, 0.5);
    reason = reason === "tool_error" ? reason : "shell_exec";
  } else if (tool === "write" || tool === "apply_patch" || tool === "edit") {
    score = Math.max(score, 0.6);
    reason = reason === "tool_error" ? reason : "filesystem_write";
  } else if (tool === "message" || tool === "sessions_send") {
    score = Math.max(score, 0.65);
    reason = reason === "tool_error" ? reason : "external_message";
  } else if (tool === "browser") {
    score = Math.max(score, 0.35);
    reason = reason === "tool_error" ? reason : "web_browse";
  } else if (tool === "read") {
    score = Math.max(score, 0.15);
    reason = reason === "tool_error" ? reason : "filesystem_read";
  }

  const resultPreviewLen = summarize(ctx.result, 2000).length;
  if (resultPreviewLen > 2000) {
    score = Math.max(score, 0.4);
    reason = reason === "tool_error" ? reason : "large_result";
  }

  return {
    kind: "heuristic",
    score: clamp01(score),
    recommendation: score >= 0.6 ? "capture" : "skip",
    reason,
  };
}

export async function evaluateWithLlm(params: {
  cfg: OpenClawConfig;
  ctx: MeridiaToolResultContext;
  modelRef: string;
  timeoutMs: number;
}): Promise<MeridiaEvaluation> {
  const startedAt = Date.now();
  const defaultRef = resolveDefaultModelForAgent({ cfg: params.cfg, agentId: undefined });
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: defaultRef.provider,
  });
  const resolved = resolveModelRefFromString({
    raw: params.modelRef,
    defaultProvider: defaultRef.provider,
    aliasIndex,
  });
  if (!resolved) {
    throw new Error(`Invalid model ref: ${params.modelRef}`);
  }

  const agentDir = resolveOpenClawAgentDir();
  await ensureOpenClawModelsJson(params.cfg, agentDir);
  const { model, error } = resolveModel(
    resolved.ref.provider,
    resolved.ref.model,
    agentDir,
    params.cfg,
  );
  if (!model || error) {
    throw new Error(
      error ?? `Failed to resolve model: ${resolved.ref.provider}/${resolved.ref.model}`,
    );
  }

  let apiKey = "";
  try {
    const auth = await resolveApiKeyForProvider({
      provider: resolved.ref.provider,
      cfg: params.cfg,
      agentDir,
    });
    apiKey = auth.apiKey ?? "";
  } catch {
    apiKey = getCustomProviderApiKey(params.cfg, resolved.ref.provider) ?? "";
  }

  const prompt = [
    "You are scoring whether a tool result should be captured as an experiential continuity record.",
    "Return ONLY valid JSON. No markdown.",
    "",
    "JSON schema:",
    '{ "score": 0.0, "reason": "short string" }',
    "",
    "Guidance: prioritize irreversible changes, external comms, errors, high uncertainty, or decisions affecting future behavior.",
    "",
    `toolName: ${params.ctx.toolName}`,
    `isError: ${params.ctx.isError ? "true" : "false"}`,
    params.ctx.meta ? `meta: ${params.ctx.meta}` : "",
    params.ctx.args !== undefined ? `args: ${summarize(params.ctx.args, 3000)}` : "",
    params.ctx.result !== undefined ? `result: ${summarize(params.ctx.result, 4000)}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, params.timeoutMs));
  timer.unref?.();
  try {
    const res = await completeSimple(
      model as Model<Api>,
      {
        messages: [
          {
            role: "user",
            content: prompt,
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey,
        maxTokens: 256,
        signal: controller.signal,
      },
    );
    const text = res.content
      .filter((block) => block.type === "text")
      .map((block) => block.text.trim())
      .join("\n")
      .trim();
    const parsed = extractFirstJsonObject(text);
    const scoreRaw = parsed?.score;
    const score = typeof scoreRaw === "number" ? scoreRaw : Number.NaN;
    if (!Number.isFinite(score)) {
      throw new Error(`LLM returned non-numeric score: ${text.slice(0, 200)}`);
    }
    const reason = typeof parsed?.reason === "string" ? parsed.reason : undefined;
    const finalScore = clamp01(score);
    return {
      kind: "llm",
      model: `${resolved.ref.provider}/${resolved.ref.model}`,
      score: finalScore,
      recommendation: finalScore >= 0.6 ? "capture" : "skip",
      reason,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}
