/**
 * Auto Model Router - 自动模型路由 Hook
 *
 * 根据消息复杂度自动选择本地或云端模型
 */

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("auto-model-router");

const execFileAsync = promisify(execFile);

interface RouterConfig {
  enabled: boolean;
  threshold: number;
  localModel: string;
  cloudModel: string;
  routerScript: string;
}

interface RouterAnalysis {
  route: "local" | "cloud";
  complexity: number;
  model: string;
  emoji: "🏠" | "☁️";
}

const DEFAULT_CONFIG: RouterConfig = {
  enabled: false,
  threshold: 40,
  localModel: "ollama/qwen3:14b",
  cloudModel: "bailian/qwen3.5-plus",
  routerScript: path.join(process.cwd(), "route-task.js"),
};

function resolveRouterConfig(cfg: OpenClawConfig): RouterConfig {
  const hookConfig = (
    cfg as unknown as { hooks?: { internal?: { entries?: Record<string, unknown> } } }
  ).hooks?.internal?.entries?.["auto-model-router"] as RouterConfig | undefined;

  if (!hookConfig?.enabled) {
    return { ...DEFAULT_CONFIG, enabled: false };
  }

  return {
    enabled: true,
    threshold: hookConfig.threshold ?? DEFAULT_CONFIG.threshold,
    localModel: hookConfig.localModel ?? DEFAULT_CONFIG.localModel,
    cloudModel: hookConfig.cloudModel ?? DEFAULT_CONFIG.cloudModel,
    routerScript: hookConfig.routerScript || path.join(process.cwd(), "route-task.js"),
  };
}

function validateRouterAnalysis(parsed: unknown, _config: RouterConfig): RouterAnalysis {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid router output: not an object");
  }

  const result = parsed as Record<string, unknown>;

  if (typeof result.route !== "string" || !["local", "cloud"].includes(result.route)) {
    throw new Error(
      `Invalid router output: route must be 'local' or 'cloud', got ${String(result.route)}`,
    );
  }

  if (typeof result.complexity !== "number" || result.complexity < 0 || result.complexity > 100) {
    throw new Error(
      `Invalid router output: complexity must be a number between 0 and 100, got ${String(result.complexity)}`,
    );
  }

  if (typeof result.model !== "string" || !result.model.trim()) {
    throw new Error(
      `Invalid router output: model must be a non-empty string, got ${String(result.model)}`,
    );
  }

  if (typeof result.emoji !== "string" || !["🏠", "☁️"].includes(result.emoji)) {
    throw new Error(
      `Invalid router output: emoji must be '🏠' or '☁️', got ${String(result.emoji)}`,
    );
  }

  return {
    route: result.route as "local" | "cloud",
    complexity: result.complexity,
    model: result.model.trim(),
    emoji: result.emoji as "🏠" | "☁️",
  };
}

export async function analyzeMessageComplexity(
  message: string,
  config: RouterConfig,
): Promise<RouterAnalysis> {
  try {
    const { stdout } = await execFileAsync("node", [config.routerScript, message, "--json"], {
      encoding: "utf8",
      timeout: 5000,
    });

    const parsed = JSON.parse(stdout);
    return validateRouterAnalysis(parsed, config);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.warn(`Router analysis failed: ${errorMessage}, using cloud model`);
    return {
      route: "cloud",
      complexity: 50,
      model: config.cloudModel,
      emoji: "☁️",
    };
  }
}

export async function getAutoModelForMessage(
  message: string,
  cfg: OpenClawConfig,
): Promise<{ model: string; emoji?: string } | null> {
  const config = resolveRouterConfig(cfg);

  if (!config.enabled || !message?.trim()) {
    return null;
  }

  const analysis = await analyzeMessageComplexity(message, config);

  log.info(
    `Route: ${analysis.route} ${analysis.emoji} | ` +
      `Complexity: ${analysis.complexity}/100 | ` +
      `Model: ${analysis.model}`,
  );

  return {
    model: analysis.model,
    emoji: analysis.route === "cloud" ? analysis.emoji : undefined,
  };
}
