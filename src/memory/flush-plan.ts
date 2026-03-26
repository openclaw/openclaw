import type { OpenClawConfig } from "../config/config.js";

export type MemoryFlushPlan = {
  softThresholdTokens: number;
  forceFlushTranscriptBytes: number;
  reserveTokensFloor: number;
  prompt: string;
  systemPrompt: string;
  relativePath: string;
};

export type MemoryFlushPlanResolver = (params: {
  cfg?: OpenClawConfig;
  nowMs?: number;
}) => MemoryFlushPlan | null;

let _resolver: MemoryFlushPlanResolver | undefined;

export function registerMemoryFlushPlanResolver(resolver: MemoryFlushPlanResolver): void {
  _resolver = resolver;
}

export function resolveMemoryFlushPlan(params: {
  cfg?: OpenClawConfig;
  nowMs?: number;
}): MemoryFlushPlan | null {
  return _resolver?.(params) ?? null;
}

export function getMemoryFlushPlanResolver(): MemoryFlushPlanResolver | undefined {
  return _resolver;
}

export function restoreMemoryFlushPlanResolver(
  resolver: MemoryFlushPlanResolver | undefined,
): void {
  _resolver = resolver;
}

export function clearMemoryFlushPlanResolver(): void {
  _resolver = undefined;
}
