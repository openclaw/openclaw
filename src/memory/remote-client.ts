import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory:remote");

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;
const RETRY_BACKOFF_MS = 1_000;

export type RemoteVectorStore = {
  id: string;
  name: string;
  status: string;
  file_counts: {
    in_progress: number;
    completed: number;
    failed: number;
    total: number;
  };
};

export type RemoteSearchResultContent = {
  type: string;
  text: string;
};

export type RemoteSearchResult = {
  file_id: string;
  filename: string;
  content: string | RemoteSearchResultContent[];
  score: number;
  chunk_index?: number;
};

/** Extract plain text from a search result's content (handles both flat string and OpenAI array format). */
export function extractSearchResultText(content: string | RemoteSearchResultContent[]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

export type RemoteSearchResponse = {
  object: string;
  data: RemoteSearchResult[];
};

export type RemoteFileRecord = {
  id: string;
  object: string;
  filename: string;
  bytes: number;
  purpose: string;
  created_at: number;
};

export type RemoteVectorStoreFile = {
  id: string;
  object: string;
  vector_store_id: string;
  file_id: string;
  status: string;
  created_at: number;
};

export type RemoteClientConfig = {
  baseUrl: string;
  apiKey?: string;
  headers: Record<string, string>;
};

export class RemoteVectorStoreClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(config: RemoteClientConfig) {
    this.baseUrl = config.baseUrl;
    this.headers = { "Content-Type": "application/json", ...config.headers };
    if (config.apiKey) {
      this.headers["Authorization"] = `Bearer ${config.apiKey}`;
    }
  }

  async createVectorStore(name: string): Promise<RemoteVectorStore> {
    const resp = await this.jsonRequest<RemoteVectorStore>("POST", "/v1/vector_stores", { name });
    return resp;
  }

  async getVectorStore(id: string): Promise<RemoteVectorStore> {
    return await this.jsonRequest<RemoteVectorStore>(
      "GET",
      `/v1/vector_stores/${encodeURIComponent(id)}`,
    );
  }

  async listVectorStores(limit = 20): Promise<{ data: RemoteVectorStore[] }> {
    return await this.jsonRequest<{ data: RemoteVectorStore[] }>(
      "GET",
      `/v1/vector_stores?limit=${limit}`,
    );
  }

  async deleteVectorStore(id: string): Promise<void> {
    await this.jsonRequest("DELETE", `/v1/vector_stores/${encodeURIComponent(id)}`);
  }

  async searchVectorStore(
    storeId: string,
    query: string,
    opts?: { maxResults?: number; scoreThreshold?: number },
  ): Promise<RemoteSearchResult[]> {
    const body: Record<string, unknown> = { query };
    if (opts?.maxResults) {
      body.max_num_results = opts.maxResults;
    }
    if (opts?.scoreThreshold !== undefined) {
      body.ranking_options = { score_threshold: opts.scoreThreshold };
    }
    const resp = await this.jsonRequest<RemoteSearchResponse>(
      "POST",
      `/v1/vector_stores/${encodeURIComponent(storeId)}/search`,
      body,
    );
    return resp.data ?? [];
  }

  async uploadFile(filename: string, content: string | Buffer): Promise<RemoteFileRecord> {
    const boundary = `----FormBoundary${Date.now()}${crypto.randomUUID()}`;
    const contentBuffer = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
    const safeFilename = filename.replace(/["\\]/g, "_").replace(/[\r\n]/g, "");

    const parts: Buffer[] = [];
    const addField = (name: string, value: string) => {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        ),
      );
    };
    addField("purpose", "assistants");

    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeFilename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
    );
    parts.push(contentBuffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const body = Buffer.concat(parts);
    const headers = {
      ...this.headers,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    };

    const url = `${this.baseUrl}/v1/files`;
    const resp = await fetchWithRetry(url, {
      method: "POST",
      headers,
      body,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`upload file failed (${resp.status}): ${text}`);
    }
    return (await resp.json()) as RemoteFileRecord;
  }

  async attachFile(storeId: string, fileId: string): Promise<RemoteVectorStoreFile> {
    return await this.jsonRequest<RemoteVectorStoreFile>(
      "POST",
      `/v1/vector_stores/${encodeURIComponent(storeId)}/files`,
      { file_id: fileId },
    );
  }

  async listFiles(storeId: string): Promise<{ data: RemoteVectorStoreFile[] }> {
    return await this.jsonRequest<{ data: RemoteVectorStoreFile[] }>(
      "GET",
      `/v1/vector_stores/${encodeURIComponent(storeId)}/files`,
    );
  }

  async detachFile(storeId: string, fileId: string): Promise<void> {
    await this.jsonRequest(
      "DELETE",
      `/v1/vector_stores/${encodeURIComponent(storeId)}/files/${encodeURIComponent(fileId)}`,
    );
  }

  async healthCheck(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.baseUrl}/health`, {
        method: "GET",
        headers: this.headers,
        signal: AbortSignal.timeout(5_000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  private async jsonRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const init: RequestInit = {
      method,
      headers: this.headers,
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    const resp = await fetchWithRetry(url, init);
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`${method} ${path} failed (${resp.status}): ${text}`);
    }
    const text = await resp.text();
    if (!text) {
      return undefined as T;
    }
    return JSON.parse(text) as T;
  }
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retries = MAX_RETRIES,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const resp = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if ((resp.status === 429 || resp.status >= 500) && attempt < retries) {
        log.warn(
          `remote vector store request ${init.method} ${url} returned ${resp.status}, retrying (${attempt + 1}/${retries})`,
        );
        await sleep(RETRY_BACKOFF_MS * (attempt + 1));
        continue;
      }
      return resp;
    } catch (err) {
      if (attempt >= retries) {
        throw err;
      }
      log.warn(
        `remote vector store request failed: ${String(err)}, retrying (${attempt + 1}/${retries})`,
      );
      await sleep(RETRY_BACKOFF_MS * (attempt + 1));
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
