import type { OpenClawConfig } from "../config/config.js";
import type { MemoryCitationsMode } from "../config/types.memory.js";

export type MemoryPromptSectionBuilder = (params: {
  availableTools: Set<string>;
  citationsMode?: MemoryCitationsMode;
}) => string[];

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

type MemoryPluginState = {
  promptBuilder?: MemoryPromptSectionBuilder;
  flushPlanResolver?: MemoryFlushPlanResolver;
};

const memoryPluginState: MemoryPluginState = {};

export function registerMemoryPromptSection(builder: MemoryPromptSectionBuilder): void {
  memoryPluginState.promptBuilder = builder;
}

export function buildMemoryPromptSection(params: {
  availableTools: Set<string>;
  citationsMode?: MemoryCitationsMode;
}): string[] {
  return memoryPluginState.promptBuilder?.(params) ?? [];
}

export function getMemoryPromptSectionBuilder(): MemoryPromptSectionBuilder | undefined {
  return memoryPluginState.promptBuilder;
}

export function registerMemoryFlushPlanResolver(resolver: MemoryFlushPlanResolver): void {
  memoryPluginState.flushPlanResolver = resolver;
}

export function resolveMemoryFlushPlan(params: {
  cfg?: OpenClawConfig;
  nowMs?: number;
}): MemoryFlushPlan | null {
  return memoryPluginState.flushPlanResolver?.(params) ?? null;
}

export function getMemoryFlushPlanResolver(): MemoryFlushPlanResolver | undefined {
  return memoryPluginState.flushPlanResolver;
}

export function restoreMemoryPluginState(state: MemoryPluginState): void {
  memoryPluginState.promptBuilder = state.promptBuilder;
  memoryPluginState.flushPlanResolver = state.flushPlanResolver;
}

export function clearMemoryPluginState(): void {
  memoryPluginState.promptBuilder = undefined;
  memoryPluginState.flushPlanResolver = undefined;
}

export const _resetMemoryPluginState = clearMemoryPluginState;
