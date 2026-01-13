import type { Llama, LlamaEmbeddingContext, LlamaModel } from "node-llama-cpp";
import { resolveApiKeyForProvider } from "../agents/model-auth.js";
import type { ClawdbotConfig } from "../config/config.js";

export type EmbeddingProvider = {
  id: string;
  model: string;
  embedQuery: (text: string) => Promise<number[]>;
  embedBatch: (texts: string[]) => Promise<number[][]>;
};

export type EmbeddingProviderResult = {
  provider: EmbeddingProvider;
  requestedProvider: "openai" | "local";
  fallbackFrom?: "local";
  fallbackReason?: string;
};

export type EmbeddingProviderOptions = {
  config: ClawdbotConfig;
  agentDir?: string;
  provider: "openai" | "local";
  remote?: {
    baseUrl?: string;
    apiKey?: string;
    headers?: Record<string, string>;
  };
  model: string;
  fallback: "openai" | "none";
  local?: {
    modelPath?: string;
    modelCacheDir?: string;
  };
};

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_LOCAL_MODEL =
  "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";

function normalizeOpenAiModel(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) return "text-embedding-3-small";
  if (trimmed.startsWith("openai/")) return trimmed.slice("openai/".length);
  return trimmed;
}

async function createOpenAiEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<EmbeddingProvider> {
  const remote = options.remote;
  const remoteApiKey = remote?.apiKey?.trim();
  const remoteBaseUrl = remote?.baseUrl?.trim();

  const { apiKey } = remoteApiKey
    ? { apiKey: remoteApiKey }
    : await resolveApiKeyForProvider({
        provider: "openai",
        cfg: options.config,
        agentDir: options.agentDir,
      });

  const providerConfig = options.config.models?.providers?.openai;
  const baseUrl =
    remoteBaseUrl || providerConfig?.baseUrl?.trim() || DEFAULT_OPENAI_BASE_URL;
  const url = `${baseUrl.replace(/\/$/, "")}/embeddings`;
  const headerOverrides = Object.assign(
    {},
    providerConfig?.headers,
    remote?.headers,
  );
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    ...headerOverrides,
  };
  const model = normalizeOpenAiModel(options.model);

  const embed = async (input: string[]): Promise<number[][]> => {
    if (input.length === 0) return [];
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, input }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`openai embeddings failed: ${res.status} ${text}`);
    }
    const payload = (await res.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    const data = payload.data ?? [];
    return data.map((entry) => entry.embedding ?? []);
  };

  return {
    id: "openai",
    model,
    embedQuery: async (text) => {
      const [vec] = await embed([text]);
      return vec ?? [];
    },
    embedBatch: embed,
  };
}

async function createLocalEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<EmbeddingProvider> {
  const modelPath = options.local?.modelPath?.trim() || DEFAULT_LOCAL_MODEL;
  const modelCacheDir = options.local?.modelCacheDir?.trim();

  // Lazy-load node-llama-cpp to keep startup light unless local is enabled.
  const { getLlama, resolveModelFile, LlamaLogLevel } = await import(
    "node-llama-cpp"
  );

  let llama: Llama | null = null;
  let embeddingModel: LlamaModel | null = null;
  let embeddingContext: LlamaEmbeddingContext | null = null;

  const ensureContext = async () => {
    if (!llama) {
      llama = await getLlama({ logLevel: LlamaLogLevel.error });
    }
    if (!embeddingModel) {
      const resolved = await resolveModelFile(
        modelPath,
        modelCacheDir || undefined,
      );
      embeddingModel = await llama.loadModel({ modelPath: resolved });
    }
    if (!embeddingContext) {
      embeddingContext = await embeddingModel.createEmbeddingContext();
    }
    return embeddingContext;
  };

  return {
    id: "local",
    model: modelPath,
    embedQuery: async (text) => {
      const ctx = await ensureContext();
      const embedding = await ctx.getEmbeddingFor(text);
      return Array.from(embedding.vector) as number[];
    },
    embedBatch: async (texts) => {
      const ctx = await ensureContext();
      const embeddings = await Promise.all(
        texts.map(async (text) => {
          const embedding = await ctx.getEmbeddingFor(text);
          return Array.from(embedding.vector) as number[];
        }),
      );
      return embeddings;
    },
  };
}

export async function createEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<EmbeddingProviderResult> {
  const requestedProvider = options.provider;
  if (options.provider === "local") {
    try {
      const provider = await createLocalEmbeddingProvider(options);
      return { provider, requestedProvider };
    } catch (err) {
      const reason = formatLocalSetupError(err);
      if (options.fallback === "openai") {
        try {
          const provider = await createOpenAiEmbeddingProvider(options);
          return {
            provider,
            requestedProvider,
            fallbackFrom: "local",
            fallbackReason: reason,
          };
        } catch (fallbackErr) {
          throw new Error(
            `${reason}\n\nFallback to OpenAI failed: ${formatError(fallbackErr)}`,
          );
        }
      }
      throw new Error(reason);
    }
  }
  const provider = await createOpenAiEmbeddingProvider(options);
  return { provider, requestedProvider };
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function formatLocalSetupError(err: unknown): string {
  const detail = formatError(err);
  return [
    "Local embeddings unavailable.",
    detail ? `Reason: ${detail}` : undefined,
    "To enable local embeddings:",
    "1) pnpm approve-builds",
    "2) select node-llama-cpp",
    "3) pnpm rebuild node-llama-cpp",
    'Or set agents.defaults.memorySearch.provider = "openai" (remote).',
  ]
    .filter(Boolean)
    .join("\n");
}
