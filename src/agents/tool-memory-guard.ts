import fs from "node:fs/promises";
import os from "node:os";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ToolMemoryGuardConfig } from "../config/types.tools.js";
import { resolveAgentConfig } from "./agent-scope.js";

const DEFAULT_MIN_AVAILABLE_BYTES = 256 * 1024 * 1024;
const DEFAULT_MIN_AVAILABLE_PERCENT = 2;

export type ToolMemorySnapshot = {
  availableBytes: number;
  totalBytes: number;
  source: "proc-meminfo" | "os";
};

export type ResolvedToolMemoryGuardConfig = {
  enabled: boolean;
  minAvailableBytes: number;
  minAvailablePercent: number;
};

export type ToolMemoryGuardDecision =
  | { ok: true; snapshot?: ToolMemorySnapshot }
  | {
      ok: false;
      reason: string;
      snapshot: ToolMemorySnapshot;
      config: ResolvedToolMemoryGuardConfig;
    };

function allowToolMemoryGuard(snapshot?: ToolMemorySnapshot): ToolMemoryGuardDecision {
  return snapshot ? { ok: true, snapshot } : { ok: true };
}

function parseProcMeminfo(text: string): ToolMemorySnapshot | undefined {
  const values = new Map<string, number>();
  for (const line of text.split("\n")) {
    const match = /^([A-Za-z_()]+):\s+(\d+)\s+kB\b/u.exec(line);
    if (!match) {
      continue;
    }
    values.set(match[1], Number(match[2]) * 1024);
  }
  const totalBytes = values.get("MemTotal");
  const availableBytes = values.get("MemAvailable") ?? values.get("MemFree");
  if (
    typeof totalBytes !== "number" ||
    typeof availableBytes !== "number" ||
    totalBytes <= 0 ||
    availableBytes < 0
  ) {
    return undefined;
  }
  return { availableBytes, totalBytes, source: "proc-meminfo" };
}

function mergeToolMemoryGuardConfig(
  global?: ToolMemoryGuardConfig,
  agent?: ToolMemoryGuardConfig,
): ToolMemoryGuardConfig | undefined {
  if (!agent) {
    return global;
  }
  if (!global) {
    return agent;
  }
  return { ...global, ...agent };
}

export function resolveToolMemoryGuardConfig(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
}): ResolvedToolMemoryGuardConfig {
  const global = params.cfg?.tools?.memoryGuard;
  const agent =
    params.agentId && params.cfg
      ? resolveAgentConfig(params.cfg, params.agentId)?.tools?.memoryGuard
      : undefined;
  const raw = mergeToolMemoryGuardConfig(global, agent);
  return {
    enabled: raw?.enabled !== false,
    minAvailableBytes:
      typeof raw?.minAvailableBytes === "number" && Number.isFinite(raw.minAvailableBytes)
        ? Math.max(1, Math.floor(raw.minAvailableBytes))
        : DEFAULT_MIN_AVAILABLE_BYTES,
    minAvailablePercent:
      typeof raw?.minAvailablePercent === "number" && Number.isFinite(raw.minAvailablePercent)
        ? Math.max(0, Math.min(100, raw.minAvailablePercent))
        : DEFAULT_MIN_AVAILABLE_PERCENT,
  };
}

export async function readToolMemorySnapshot(): Promise<ToolMemorySnapshot | undefined> {
  if (process.platform === "linux") {
    try {
      const parsed = parseProcMeminfo(await fs.readFile("/proc/meminfo", "utf8"));
      if (parsed) {
        return parsed;
      }
    } catch {
      // Fall back to Node's portable process view below.
    }
  }
  const totalBytes = os.totalmem();
  const availableBytes = os.freemem();
  if (totalBytes <= 0 || availableBytes < 0) {
    return undefined;
  }
  return { availableBytes, totalBytes, source: "os" };
}

function formatBytes(bytes: number): string {
  const mib = bytes / 1024 / 1024;
  if (mib < 1024) {
    return `${Math.round(mib)} MiB`;
  }
  return `${(mib / 1024).toFixed(1)} GiB`;
}

export function evaluateToolMemoryGuard(params: {
  config: ResolvedToolMemoryGuardConfig;
  snapshot?: ToolMemorySnapshot;
}): ToolMemoryGuardDecision {
  if (!params.config.enabled || !params.snapshot) {
    return allowToolMemoryGuard(params.snapshot);
  }
  const availablePercent = (params.snapshot.availableBytes / params.snapshot.totalBytes) * 100;
  const belowBytes = params.snapshot.availableBytes < params.config.minAvailableBytes;
  const belowPercent = availablePercent < params.config.minAvailablePercent;
  if (!belowBytes && !belowPercent) {
    return allowToolMemoryGuard(params.snapshot);
  }
  const reason =
    "Tool call blocked because host memory is low " +
    `(${formatBytes(params.snapshot.availableBytes)} available, ${availablePercent.toFixed(1)}%). ` +
    `Required at least ${formatBytes(params.config.minAvailableBytes)} and ` +
    `${params.config.minAvailablePercent}% available.`;
  return {
    ok: false,
    reason,
    snapshot: params.snapshot,
    config: params.config,
  };
}

export async function checkToolMemoryGuard(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
}): Promise<ToolMemoryGuardDecision> {
  const config = resolveToolMemoryGuardConfig(params);
  if (!config.enabled) {
    return allowToolMemoryGuard();
  }
  return evaluateToolMemoryGuard({
    config,
    snapshot: await readToolMemorySnapshot(),
  });
}

export const __testing = {
  DEFAULT_MIN_AVAILABLE_BYTES,
  DEFAULT_MIN_AVAILABLE_PERCENT,
  parseProcMeminfo,
};
