import type { EmbeddingInput } from "../../packages/memory-host-sdk/src/host/embedding-inputs.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SecretInput } from "../config/types.secrets.js";

export type MemoryEmbeddingBatchChunk = {
  text: string;
  embeddingInput?: EmbeddingInput;
};

export type MemoryEmbeddingBatchOptions = {
  agentId: string;
  chunks: MemoryEmbeddingBatchChunk[];
  wait: boolean;
  concurrency: number;
  pollIntervalMs: number;
  timeoutMs: number;
  debug: (message: string, data?: Record<string, unknown>) => void;
};

export type MemoryEmbeddingProviderRuntime = {
  id: string;
  cacheKeyData?: Record<string, unknown>;
  batchEmbed?: (options: MemoryEmbeddingBatchOptions) => Promise<number[][] | null>;
};

export type MemoryEmbeddingProvider = {
  id: string;
  model: string;
  maxInputTokens?: number;
  embedQuery: (text: string) => Promise<number[]>;
  embedBatch: (texts: string[]) => Promise<number[][]>;
  embedBatchInputs?: (inputs: EmbeddingInput[]) => Promise<number[][]>;
};

export type MemoryEmbeddingProviderCreateOptions = {
  config: OpenClawConfig;
  agentDir?: string;
  remote?: {
    baseUrl?: string;
    apiKey?: SecretInput;
    headers?: Record<string, string>;
  };
  model: string;
  local?: {
    modelPath?: string;
    modelCacheDir?: string;
  };
  outputDimensionality?: number;
};

export type MemoryEmbeddingProviderCreateResult = {
  provider: MemoryEmbeddingProvider | null;
  runtime?: MemoryEmbeddingProviderRuntime;
};

export type MemoryEmbeddingProviderAdapter = {
  id: string;
  defaultModel?: string;
  transport?: "local" | "remote";
  autoSelectPriority?: number;
  allowExplicitWhenConfiguredAuto?: boolean;
  supportsMultimodalEmbeddings?: (params: { model: string }) => boolean;
  create: (
    options: MemoryEmbeddingProviderCreateOptions,
  ) => Promise<MemoryEmbeddingProviderCreateResult>;
  formatSetupError?: (err: unknown) => string;
  shouldContinueAutoSelection?: (err: unknown) => boolean;
};

export type RegisteredMemoryEmbeddingProvider = {
  adapter: MemoryEmbeddingProviderAdapter;
  ownerPluginId?: string;
};

const memoryEmbeddingProviders = new Map<string, RegisteredMemoryEmbeddingProvider>();

export function registerMemoryEmbeddingProvider(
  adapter: MemoryEmbeddingProviderAdapter,
  options?: { ownerPluginId?: string },
): void {
  memoryEmbeddingProviders.set(adapter.id, {
    adapter,
    ownerPluginId: options?.ownerPluginId,
  });
}

export function getRegisteredMemoryEmbeddingProvider(
  id: string,
): RegisteredMemoryEmbeddingProvider | undefined {
  return memoryEmbeddingProviders.get(id);
}

export function getMemoryEmbeddingProvider(id: string): MemoryEmbeddingProviderAdapter | undefined {
  return memoryEmbeddingProviders.get(id)?.adapter;
}

export function listRegisteredMemoryEmbeddingProviders(): RegisteredMemoryEmbeddingProvider[] {
  return Array.from(memoryEmbeddingProviders.values());
}

export function listMemoryEmbeddingProviders(): MemoryEmbeddingProviderAdapter[] {
  return listRegisteredMemoryEmbeddingProviders().map((entry) => entry.adapter);
}

export function restoreMemoryEmbeddingProviders(adapters: MemoryEmbeddingProviderAdapter[]): void {
  memoryEmbeddingProviders.clear();
  for (const adapter of adapters) {
    registerMemoryEmbeddingProvider(adapter);
  }
}

export function restoreRegisteredMemoryEmbeddingProviders(
  entries: RegisteredMemoryEmbeddingProvider[],
): void {
  memoryEmbeddingProviders.clear();
  for (const entry of entries) {
    registerMemoryEmbeddingProvider(entry.adapter, {
      ownerPluginId: entry.ownerPluginId,
    });
  }
}

export function clearMemoryEmbeddingProviders(): void {
  memoryEmbeddingProviders.clear();
}

export const _resetMemoryEmbeddingProviders = clearMemoryEmbeddingProviders;
