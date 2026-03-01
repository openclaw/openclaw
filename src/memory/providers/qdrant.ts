import { QdrantClient } from "@qdrant/js-client-rest";
import { v4 as uuidv4 } from "uuid";

export interface MemoryVector {
  id: string;
  content: string;
  metadata: Record<string, any>;
  embedding: number[];
}

export class QdrantProvider {
  private client: QdrantClient;
  private collectionName: string;

  constructor(url: string, apiKey?: string, collectionName: string = "openclaw_memory") {
    this.client = new QdrantClient({ url, apiKey });
    this.collectionName = collectionName;
  }

  async init() {
    const result = await this.client.getCollections();
    const exists = result.collections.some((c) => c.name === this.collectionName);

    if (!exists) {
      await this.client.createCollection(this.collectionName, {
        vectors: {
          size: 1536, // Default OpenAI embedding size
          distance: "Cosine",
        },
      });
    }
  }

  async add(content: string, embedding: number[], metadata: Record<string, any> = {}) {
    const id = uuidv4();
    await this.client.upsert(this.collectionName, {
      points: [
        {
          id,
          vector: embedding,
          payload: { content, ...metadata },
        },
      ],
    });
    return id;
  }

  async search(embedding: number[], limit: number = 5) {
    const results = await this.client.search(this.collectionName, {
      vector: embedding,
      limit,
      with_payload: true,
    });

    return results.map((res) => ({
      id: res.id,
      content: res.payload?.content as string,
      score: res.score,
      metadata: res.payload,
    }));
  }
}
