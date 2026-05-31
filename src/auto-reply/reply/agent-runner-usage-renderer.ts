import { spawn } from "node:child_process";
import type { UsageLineConfig, UsageLineSurfaceConfig } from "../../config/types.messages.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveUserPath } from "../../utils.js";
import { estimateUsageCost, type ModelCostConfig } from "../../utils/usage-format.js";

type UsageLineMode = "tokens" | "full";
type UsageLineFormat = "plain" | "preformatted" | "raw";

type UsageLineUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

export type UsageLineRenderParams = {
  config?: UsageLineConfig;
  defaultLine: string | null;
  mode: UsageLineMode;
  surface?: string;
  chatType?: string;
  sessionKey?: string;
  sessionId?: string;
  model?: string;
  provider?: string;
  reasoning?: string;
  workspaceDir?: string;
  projectDir?: string;
  usage?: UsageLineUsage;
  context?: {
    usedTokens?: number;
    maxTokens?: number;
  };
  costConfig?: ModelCostConfig;
  durationMs?: number;
};

type ResolvedUsageLineRenderer = {
  command: string;
  args: string[];
  format: UsageLineFormat;
  timeoutMs: number;
  maxOutputChars: number;
  maxOutputLines: number;
};

const DEFAULT_TIMEOUT_MS = 1500;
const DEFAULT_MAX_OUTPUT_CHARS = 500;
const DEFAULT_MAX_OUTPUT_LINES = 2;

const resolveRenderer = (
  config: UsageLineConfig | undefined,
  surface: string | undefined,
): ResolvedUsageLineRenderer | null => {
  if (!config || config.enabled === false) {
    return null;
  }
  const surfaceConfig = surface ? config.surfaces?.[surface] : undefined;
  if (surfaceConfig?.enabled === false) {
    return null;
  }
  const merged: UsageLineConfig & UsageLineSurfaceConfig = {
    ...config,
    ...(surfaceConfig ?? {}),
  };
  const command = typeof merged.command === "string" ? merged.command.trim() : "";
  if (!command) {
    return null;
  }
  return {
    command: resolveUserPath(command),
    args: Array.isArray(merged.args) ? merged.args : [],
    format: merged.format ?? "plain",
    timeoutMs: merged.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOutputChars: merged.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
    maxOutputLines: merged.maxOutputLines ?? DEFAULT_MAX_OUTPUT_LINES,
  };
};

const buildUsageLineContext = (params: UsageLineRenderParams) => {
  const inputTokens = params.usage?.input;
  const outputTokens = params.usage?.output;
  const cacheReadTokens = params.usage?.cacheRead;
  const cacheWriteTokens = params.usage?.cacheWrite;
  const totalTokens =
    params.usage?.total ??
    (typeof inputTokens === "number" || typeof outputTokens === "number"
      ? (inputTokens ?? 0) + (outputTokens ?? 0) + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)
      : undefined);
  const maxTokens = params.context?.maxTokens;
  const usedTokens = params.context?.usedTokens;
  const pctUsed =
    typeof usedTokens === "number" && typeof maxTokens === "number" && maxTokens > 0
      ? Math.round((usedTokens / maxTokens) * 1000) / 10
      : undefined;
  const turnUsd =
    params.usage && params.costConfig
      ? estimateUsageCost({ usage: params.usage, cost: params.costConfig })
      : undefined;

  return {
    schema: "openclaw.usageLine.v1",
    mode: params.mode,
    surface: params.surface,
    chat_type: params.chatType,
    model: {
      id: params.model,
      display_name: params.model,
      provider: params.provider,
      reasoning: params.reasoning,
    },
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: cacheReadTokens,
      cache_write_tokens: cacheWriteTokens,
      total_tokens: totalTokens,
    },
    context: {
      used_tokens: usedTokens,
      max_tokens: maxTokens,
      pct_used: pctUsed,
    },
    cost: {
      turn_usd: turnUsd ?? null,
      available: params.costConfig !== undefined,
    },
    rendering: {
      max_reasonable_chars: params.surface === "telegram" ? 180 : 220,
    },
    session: {
      key: params.sessionKey,
      id: params.sessionId,
    },
    workspace: {
      current_dir: params.workspaceDir,
      project_dir: params.projectDir,
    },
    timing: {
      duration_ms: params.durationMs,
    },
  };
};

const applyUsageLineFormat = (output: string, format: UsageLineFormat): string => {
  if (format === "raw" || format === "plain") {
    return output;
  }
  const safeOutput = output.replaceAll("```", "`\u200b``");
  return `\`\`\`text\n${safeOutput}\n\`\`\``;
};

const runRendererCommand = async (
  renderer: ResolvedUsageLineRenderer,
  context: unknown,
): Promise<string | null> =>
  await new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const child = spawn(renderer.command, renderer.args, {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    const finish = (value: string | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(null);
    }, renderer.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > renderer.maxOutputChars) {
        child.kill("SIGTERM");
        finish(null);
      }
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      if (code !== 0) {
        finish(null);
        return;
      }
      const normalized = stdout.replaceAll("\r\n", "\n").trim();
      if (!normalized || normalized.length > renderer.maxOutputChars) {
        finish(null);
        return;
      }
      if (normalized.split("\n").length > renderer.maxOutputLines) {
        finish(null);
        return;
      }
      finish(normalized);
    });
    child.stdin.end(`${JSON.stringify(context)}\n`);
  });

export const renderUsageLine = async (params: UsageLineRenderParams): Promise<string | null> => {
  const renderer = resolveRenderer(params.config, params.surface);
  if (!renderer) {
    return params.defaultLine;
  }
  try {
    const output = await runRendererCommand(renderer, buildUsageLineContext(params));
    if (!output) {
      return params.defaultLine;
    }
    return applyUsageLineFormat(output, renderer.format);
  } catch (error) {
    logVerbose(`usage-line renderer failed: ${formatErrorMessage(error)}`);
    return params.defaultLine;
  }
};
