import type { OpenClawConfig } from "../config/config.js";
import type { MemoryCitationsMode } from "../config/types.memory.js";
import type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySyncProgressUpdate,
} from "../plugin-sdk/memory-core-host-engine-storage.js";

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

export type RegisteredMemorySearchManager = {
  status(): MemoryProviderStatus;
  probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult>;
  probeVectorAvailability(): Promise<boolean>;
  sync?(params?: {
    reason?: string;
    force?: boolean;
    sessionFiles?: string[];
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void>;
  close?(): Promise<void>;
};

export type MemoryRuntimeQmdConfig = {
  command?: string;
};

export type MemoryRuntimeBackendConfig =
  | {
      backend: "builtin";
    }
  | {
      backend: "qmd";
      qmd?: MemoryRuntimeQmdConfig;
    }
  | {
      backend: "chain";
      chain?: {
        providers?: Array<{
          name: string;
          priority: "primary" | "secondary" | "fallback";
          backend?: string;
          plugin?: string;
          enabled?: boolean;
          timeout?: {
            add?: number;
            search?: number;
            update?: number;
            delete?: number;
          };
          retry?: {
            maxAttempts?: number;
            backoffMs?: number;
          };
          circuitBreaker?: {
            failureThreshold?: number;
            resetTimeoutMs?: number;
          };
        }>;
        global?: {
          defaultTimeout?: number;
          enableFallback?: boolean;
          healthCheckInterval?: number;
        };
      };
    };

export type MemoryPluginRuntime = {
  getMemorySearchManager(params: {
    cfg: OpenClawConfig;
    agentId: string;
    purpose?: "default" | "status";
  }): Promise<{
    manager: RegisteredMemorySearchManager | null;
    error?: string;
  }>;
  resolveMemoryBackendConfig(params: {
    cfg: OpenClawConfig;
    agentId: string;
  }): MemoryRuntimeBackendConfig;
  closeAllMemorySearchManagers?(): Promise<void>;
};

type MemoryPluginState = {
  promptBuilder?: MemoryPromptSectionBuilder;
  flushPlanResolver?: MemoryFlushPlanResolver;
  runtime?: MemoryPluginRuntime;
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

export function registerMemoryRuntime(runtime: MemoryPluginRuntime): void {
  memoryPluginState.runtime = runtime;
}

export function getMemoryRuntime(): MemoryPluginRuntime | undefined {
  return memoryPluginState.runtime;
}

export function hasMemoryRuntime(): boolean {
  return memoryPluginState.runtime !== undefined;
}

export function restoreMemoryPluginState(state: MemoryPluginState): void {
  memoryPluginState.promptBuilder = state.promptBuilder;
  memoryPluginState.flushPlanResolver = state.flushPlanResolver;
  memoryPluginState.runtime = state.runtime;
}

export function clearMemoryPluginState(): void {
  memoryPluginState.promptBuilder = undefined;
  memoryPluginState.flushPlanResolver = undefined;
  memoryPluginState.runtime = undefined;
}

export const _resetMemoryPluginState = clearMemoryPluginState;
