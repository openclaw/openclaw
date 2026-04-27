import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listRegisteredMemoryEmbeddingProviders, type MemoryEmbeddingProviderAdapter } from "./memory-embedding-providers.js";
export { listRegisteredMemoryEmbeddingProviders };
export declare function listRegisteredMemoryEmbeddingProviderAdapters(): MemoryEmbeddingProviderAdapter[];
export declare function listMemoryEmbeddingProviders(cfg?: OpenClawConfig): MemoryEmbeddingProviderAdapter[];
export declare function getMemoryEmbeddingProvider(id: string, cfg?: OpenClawConfig): MemoryEmbeddingProviderAdapter | undefined;
