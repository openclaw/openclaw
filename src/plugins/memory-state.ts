import type { OpenClawConfig } from "../config/config.js";
import type { MemoryCitationsMode } from "../config/types.memory.js";
import type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySyncProgressUpdate,
} from "../memory-host-sdk/engine-storage.js";

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

export type MemoryPublicArtifact = {
  workspaceDir: string;
  relativePath: string;
  absolutePath: string;
  kind: string;
  contentType: string;
  agentIds: string[];
};

export type MemoryPluginCapability = {
  promptBuilder?: MemoryPromptSectionBuilder;
  flushPlanResolver?: MemoryFlushPlanResolver;
  runtime?: MemoryPluginRuntime;
  publicArtifacts?: {
    listArtifacts(params: { cfg: OpenClawConfig }): Promise<MemoryPublicArtifact[]>;
  };
};

export type MemoryCapabilityRegistration = {
  pluginId: string;
  capability: MemoryPluginCapability;
};

type MemoryPluginState = {
  capability?: MemoryCapabilityRegistration;
  promptBuilder?: MemoryPromptSectionBuilder;
  flushPlanResolver?: MemoryFlushPlanResolver;
  runtime?: MemoryPluginRuntime;
};

const memoryPluginState: MemoryPluginState = {};

export function registerMemoryCapability(
  pluginId: string,
  capability: MemoryPluginCapability,
): void {
  memoryPluginState.capability = {
    pluginId,
    capability: { ...capability },
  };
}

export function getMemoryCapabilityRegistration(): MemoryCapabilityRegistration | undefined {
  return memoryPluginState.capability
    ? {
        pluginId: memoryPluginState.capability.pluginId,
        capability: { ...memoryPluginState.capability.capability },
      }
    : undefined;
}

export function registerMemoryPromptSection(builder: MemoryPromptSectionBuilder): void {
  memoryPluginState.promptBuilder = builder;
}

export function buildMemoryPromptSection(params: {
  availableTools: Set<string>;
  citationsMode?: MemoryCitationsMode;
}): string[] {
  return (
    memoryPluginState.capability?.capability.promptBuilder?.(params) ??
    memoryPluginState.promptBuilder?.(params) ??
    []
  );
}

export function getMemoryPromptSectionBuilder(): MemoryPromptSectionBuilder | undefined {
  return memoryPluginState.capability?.capability.promptBuilder ?? memoryPluginState.promptBuilder;
}

export function registerMemoryFlushPlanResolver(resolver: MemoryFlushPlanResolver): void {
  memoryPluginState.flushPlanResolver = resolver;
}

export function resolveMemoryFlushPlan(params: {
  cfg?: OpenClawConfig;
  nowMs?: number;
}): MemoryFlushPlan | null {
  return (
    memoryPluginState.capability?.capability.flushPlanResolver?.(params) ??
    memoryPluginState.flushPlanResolver?.(params) ??
    null
  );
}

export function getMemoryFlushPlanResolver(): MemoryFlushPlanResolver | undefined {
  return (
    memoryPluginState.capability?.capability.flushPlanResolver ??
    memoryPluginState.flushPlanResolver
  );
}

export function registerMemoryRuntime(runtime: MemoryPluginRuntime): void {
  memoryPluginState.runtime = runtime;
}

export function getMemoryRuntime(): MemoryPluginRuntime | undefined {
  return memoryPluginState.capability?.capability.runtime ?? memoryPluginState.runtime;
}

export function hasMemoryRuntime(): boolean {
  return getMemoryRuntime() !== undefined;
}

function cloneMemoryPublicArtifact(artifact: MemoryPublicArtifact): MemoryPublicArtifact {
  return {
    ...artifact,
    agentIds: [...artifact.agentIds],
  };
}

export async function listActiveMemoryPublicArtifacts(params: {
  cfg: OpenClawConfig;
}): Promise<MemoryPublicArtifact[]> {
  const listed =
    (await memoryPluginState.capability?.capability.publicArtifacts?.listArtifacts(params)) ?? [];
  return listed.map(cloneMemoryPublicArtifact);
}

export function restoreMemoryPluginState(state: MemoryPluginState): void {
  memoryPluginState.capability = state.capability
    ? {
        pluginId: state.capability.pluginId,
        capability: { ...state.capability.capability },
      }
    : undefined;
  memoryPluginState.promptBuilder = state.promptBuilder;
  memoryPluginState.flushPlanResolver = state.flushPlanResolver;
  memoryPluginState.runtime = state.runtime;
}

export function clearMemoryPluginState(): void {
  memoryPluginState.capability = undefined;
  memoryPluginState.promptBuilder = undefined;
  memoryPluginState.flushPlanResolver = undefined;
  memoryPluginState.runtime = undefined;
}

export const _resetMemoryPluginState = clearMemoryPluginState;
