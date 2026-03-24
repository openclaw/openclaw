import { fetchWithTimeout } from "../../utils/fetch-timeout.js";

export type Mem0RecallParams = {
  query: string;
  userId?: string;
  agentId?: string;
  runId?: string;
  limit: number;
  threshold: number;
};

export type Mem0StoreParams = {
  memory: string;
  userMessage: string;
  assistantMessage: string;
  toolSummary?: string;
  userId?: string;
  agentId?: string;
  runId?: string;
};

export type MemoryRecallResult = {
  id?: string;
  text: string;
  score?: number;
};

export type Mem0Adapter = {
  recall: (params: Mem0RecallParams) => Promise<MemoryRecallResult[]>;
  store: (params: Mem0StoreParams) => Promise<void>;
  healthCheck: () => Promise<boolean>;
};

type Mem0ApiAdapterOptions = {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 6_000;
const SEARCH_PATH = "/v1/memories/search";
const STORE_PATH = "/v1/memories";
const HEALTH_PATH = "/health";

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function buildUrl(baseUrl: string, path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizeBaseUrl(baseUrl)}${normalizedPath}`;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function toNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseRecallResults(payload: unknown): MemoryRecallResult[] {
  const root = asObject(payload);
  if (!root) {
    return [];
  }
  const candidates = [...asArray(root.results), ...asArray(root.memories), ...asArray(root.data)];
  const parsed: MemoryRecallResult[] = [];
  for (const candidate of candidates) {
    const obj = asObject(candidate);
    if (!obj) {
      continue;
    }
    const text =
      toText(obj.text) ??
      toText(obj.memory) ??
      toText(obj.content) ??
      toText(obj.value) ??
      toText(asObject(obj.metadata)?.summary);
    if (!text) {
      continue;
    }
    const id = toText(obj.id) ?? toText(obj.memory_id);
    const score = toNumber(obj.score) ?? toNumber(obj.similarity);
    parsed.push({ id, text, score });
  }
  return parsed;
}

async function readJsonSafe(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function buildHeaders(apiKey: string): HeadersInit {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

export function createMem0ApiAdapter(options: Mem0ApiAdapterOptions): Mem0Adapter {
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const headers = buildHeaders(options.apiKey);

  return {
    async healthCheck(): Promise<boolean> {
      const response = await fetchWithTimeout(
        buildUrl(baseUrl, HEALTH_PATH),
        {
          method: "GET",
          headers,
        },
        timeoutMs,
      );
      return response.ok;
    },

    async recall(params: Mem0RecallParams): Promise<MemoryRecallResult[]> {
      const body = {
        query: params.query,
        top_k: params.limit,
        threshold: params.threshold,
        user_id: params.userId,
        agent_id: params.agentId,
        run_id: params.runId,
      };
      const response = await fetchWithTimeout(
        buildUrl(baseUrl, SEARCH_PATH),
        {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        },
        timeoutMs,
      );
      if (!response.ok) {
        throw new Error(`mem0 recall failed status=${response.status}`);
      }
      return parseRecallResults(await readJsonSafe(response));
    },

    async store(params: Mem0StoreParams): Promise<void> {
      const body = {
        memory: params.memory,
        input: params.userMessage,
        output: params.assistantMessage,
        user_id: params.userId,
        agent_id: params.agentId,
        run_id: params.runId,
        metadata: {
          tool_summary: params.toolSummary,
        },
      };
      const response = await fetchWithTimeout(
        buildUrl(baseUrl, STORE_PATH),
        {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        },
        timeoutMs,
      );
      if (!response.ok) {
        throw new Error(`mem0 store failed status=${response.status}`);
      }
    },
  };
}
