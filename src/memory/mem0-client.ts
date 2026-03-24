import type { MemorySearchResult, MemorySource } from "./types.js";

type Mem0MemoryResult = {
  id: string;
  memory: string;
  score: number;
};

export class Mem0Client {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey;
    // Default to the official API if no custom base URL is provided.
    this.baseUrl = baseUrl?.replace(/\/+$/, "") || "https://api.mem0.ai/v1";
  }

  /**
   * Adds a new memory to the Mem0 backend.
   */
  async addMemory(content: string, userId: string, agentId: string): Promise<void> {
    const url = `${this.baseUrl}/memories/`;
    const payload = {
      messages: [{ role: "user", content }],
      user_id: userId,
      agent_id: agentId,
      output_format: "v1.1",
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Token ${this.apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Mem0 APi Error [${res.status}]: ${text}`);
    }
  }

  /**
   * Searches Mem0 for relevant semantic memories.
   */
  async searchMemories(
    query: string,
    userId: string,
    agentId: string,
    limit = 5,
  ): Promise<MemorySearchResult[]> {
    const url = `${this.baseUrl}/memories/search/`;
    const payload = {
      query,
      user_id: userId,
      agent_id: agentId,
      limit,
      output_format: "v1.1",
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Token ${this.apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Mem0 API Error [${res.status}]: ${text}`);
    }

    const data = (await res.json()) as Mem0MemoryResult[];

    // Transform Mem0 answers into OpenClaw MemorySearchResult
    return data.map((item) => ({
      path: `mem0://${item.id}`,
      startLine: 1,
      endLine: 1,
      score: item.score,
      snippet: item.memory,
      // Source cannot be literally "mem0" if MemorySource is "memory" | "sessions"
      // Wait, we probably need to cast it or add "mem0" to MemorySource if TS complains. Let's use "memory" for now.
      source: "memory" as MemorySource,
      citation: `[Mem0 Semantic Knowledge]`,
    }));
  }
}
