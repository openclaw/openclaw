/**
 * Auto Model Router - 自动模型路由 Hook
 *
 * 根据消息复杂度自动选择本地或云端模型
 */

import { execSync } from "node:child_process";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("auto-model-router");

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
  enabled: true,
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

export function analyzeMessageComplexity(
  message: string,
  config: RouterConfig,
): RouterAnalysis | null {
  try {
    const escapedMessage = message.replace(/"/g, '\\"').replace(/\n/g, " ");

    const result = execSync(`node "${config.routerScript}" "${escapedMessage}" --json`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 5000,
    });

    return JSON.parse(result) as RouterAnalysis;
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

export function getAutoModelForMessage(
  message: string,
  cfg: OpenClawConfig,
): { model: string; emoji?: string } | null {
  const config = resolveRouterConfig(cfg);

  if (!config.enabled || !message?.trim()) {
    return null;
  }

  const analysis = analyzeMessageComplexity(message, config);

  if (!analysis) {
    return null;
  }

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
