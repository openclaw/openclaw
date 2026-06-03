import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/rerankers");

export type RerankDocument = {
  id: string;
  content: string;
  score: number;
};

export type RerankParams = {
  query: string;
  documents: RerankDocument[];
  limit: number;
  /** Lambda for MMR-style rerankers: 1.0 = relevance-only, 0.0 = diversity-only. Optional; plugins ignore it when not applicable. */
  lambda?: number;
};

export type RerankResult = Array<{
  id: string;
  score: number;
}>;

export type MemoryRerankerPlugin = {
  id: string;
  rerank: (params: RerankParams) => Promise<RerankResult>;
};

const MEMORY_RERANKERS_KEY = Symbol.for("openclaw.memoryRerankers");

function getMemoryRerankers(): Map<string, MemoryRerankerPlugin> {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const existing = globalStore[MEMORY_RERANKERS_KEY];
  if (existing instanceof Map) {
    return existing as Map<string, MemoryRerankerPlugin>;
  }
  const created = new Map<string, MemoryRerankerPlugin>();
  globalStore[MEMORY_RERANKERS_KEY] = created;
  return created;
}

export function registerMemoryReranker(impl: MemoryRerankerPlugin): void {
  getMemoryRerankers().set(impl.id, impl);
  log.debug("memory rerankers: registered", { id: impl.id });
  log.debug("memory rerankers: priority list", {
    rerankers: [...getMemoryRerankers().keys()],
  });
}

export function getRegisteredMemoryReranker(id: string): MemoryRerankerPlugin | undefined {
  return getMemoryRerankers().get(id);
}

export function listRegisteredMemoryRerankers(): MemoryRerankerPlugin[] {
  return Array.from(getMemoryRerankers().values());
}

export function restoreMemoryRerankers(rerankers: MemoryRerankerPlugin[]): void {
  getMemoryRerankers().clear();
  for (const reranker of rerankers) {
    registerMemoryReranker(reranker);
  }
}
