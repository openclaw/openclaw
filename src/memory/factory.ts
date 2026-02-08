import type { OpenClawConfig } from "../config/config.js";
import { MemoryIndexManager } from "./manager.js";
import { QdrantProvider } from "./providers/qdrant.js";

export type MemoryStore = MemoryIndexManager | QdrantProvider;

export async function createMemoryStore(
  params: {
    cfg: OpenClawConfig;
    agentId: string;
    type?: "sqlite" | "qdrant";
  }
): Promise<MemoryStore | null> {
  const type = params.type ?? "sqlite";

  if (type === "qdrant") {
    // Resolve Qdrant config from agent settings
    // This assumes specific config keys are added to the agent schema
    const qdrantUrl = process.env.QDRANT_URL;
    const qdrantKey = process.env.QDRANT_API_KEY;
    
    if (!qdrantUrl) {
      throw new Error("Qdrant URL not configured (QDRANT_URL env var missing)");
    }

    const provider = new QdrantProvider(qdrantUrl, qdrantKey);
    await provider.init();
    return provider;
  }

  // Default to existing SQLite manager
  return MemoryIndexManager.get(params);
}
