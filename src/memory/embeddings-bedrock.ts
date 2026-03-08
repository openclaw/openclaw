import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { resolveApiKeyForProvider } from "../agents/model-auth.js";
import { debugEmbeddingsLog } from "./embeddings-debug.js";
import type { EmbeddingProvider, EmbeddingProviderOptions } from "./embeddings.js";

export type BedrockEmbeddingClient = {
  region: string | undefined;
  model: string;
};

export const DEFAULT_BEDROCK_EMBEDDING_MODEL = "amazon.titan-embed-text-v2:0";

const BEDROCK_MAX_INPUT_TOKENS: Record<string, number> = {
  "amazon.titan-embed-text-v2:0": 8192,
  "amazon.titan-embed-text-v1": 8192,
  "cohere.embed-english-v3": 512,
  "cohere.embed-multilingual-v3": 512,
};

export function normalizeBedrockModel(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) {
    return DEFAULT_BEDROCK_EMBEDDING_MODEL;
  }
  if (trimmed.startsWith("amazon-bedrock/")) {
    return trimmed.slice("amazon-bedrock/".length);
  }
  if (trimmed.startsWith("bedrock/")) {
    return trimmed.slice("bedrock/".length);
  }
  return trimmed;
}

function isCohereModel(model: string): boolean {
  return model.startsWith("cohere.");
}

function isTitanV2(model: string): boolean {
  return model.includes("v2");
}

function parseRegionFromBaseUrl(baseUrl?: string): string | undefined {
  if (!baseUrl) {
    return undefined;
  }
  const match = baseUrl.match(/bedrock-runtime\.([a-z0-9-]+)\.amazonaws\.com/);
  return match?.[1];
}

export async function createBedrockEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<{ provider: EmbeddingProvider; client: BedrockEmbeddingClient }> {
  // Resolve auth — we just need to verify AWS credentials are available.
  // The BedrockRuntimeClient handles actual credential resolution via the
  // default credential provider chain.
  const auth = await resolveApiKeyForProvider({
    provider: "amazon-bedrock",
    cfg: options.config,
    agentDir: options.agentDir,
  });
  if (auth.mode !== "aws-sdk") {
    throw new Error(
      `Bedrock embedding provider requires AWS SDK auth (got ${auth.mode}). ` +
        `Set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY, AWS_PROFILE, or AWS_BEARER_TOKEN_BEDROCK.`,
    );
  }

  const providerConfig = options.config.models?.providers?.["amazon-bedrock"];
  const baseUrl = providerConfig?.baseUrl?.trim();
  // Prefer region extracted from an explicit base URL; otherwise let the AWS SDK
  // resolve the region from the environment (AWS_REGION, AWS_DEFAULT_REGION,
  // shared-config profile, EC2 metadata, etc.).  Hard-coding "us-east-1" would
  // break users whose Bedrock model access is in another region.
  const region = parseRegionFromBaseUrl(baseUrl);
  const model = normalizeBedrockModel(options.model);

  debugEmbeddingsLog("memory embeddings: bedrock client", {
    region: region ?? "(sdk-resolved)",
    model,
    authSource: auth.source,
  });

  const bedrockClient = new BedrockRuntimeClient(region ? { region } : {});

  // Eagerly resolve credentials to fail fast in "auto" mode when no AWS
  // creds are configured.  The default chain succeeds with empty/expired
  // tokens that only fail at InvokeModel time, which would break users
  // who have a working Voyage/Mistral key but no AWS setup.
  try {
    const creds = await bedrockClient.config.credentials();
    if (!creds?.accessKeyId) {
      throw new Error("No AWS credentials resolved");
    }
  } catch {
    throw new Error(
      "No API key found for provider amazon-bedrock. " +
        "Set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY, AWS_PROFILE, or run on an instance with an IAM role.",
    );
  }

  const invokeModel = async (body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const command = new InvokeModelCommand({
      modelId: model,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify(body),
    });
    const response = await bedrockClient.send(command);
    const responseBody = new TextDecoder().decode(response.body);
    return JSON.parse(responseBody) as Record<string, unknown>;
  };

  const embedQuery = async (text: string): Promise<number[]> => {
    if (!text.trim()) {
      return [];
    }
    if (isCohereModel(model)) {
      const result = await invokeModel({
        texts: [text],
        input_type: "search_query",
        truncate: "END",
      });
      const embeddings = result.embeddings as number[][];
      return embeddings?.[0] ?? [];
    }
    // Titan models — v2 supports dimensions/normalize, v1 only accepts inputText
    const result = await invokeModel({
      inputText: text,
      ...(isTitanV2(model) ? { dimensions: 1024, normalize: true } : {}),
    });
    return (result.embedding as number[]) ?? [];
  };

  const embedBatch = async (texts: string[]): Promise<number[][]> => {
    if (texts.length === 0) {
      return [];
    }
    if (isCohereModel(model)) {
      const result = await invokeModel({
        texts,
        input_type: "search_document",
        truncate: "END",
      });
      const embeddings = result.embeddings as number[][];
      return texts.map((_, index) => embeddings?.[index] ?? []);
    }
    // Titan models don't support batch — invoke individually
    const results = await Promise.all(
      texts.map(async (text) => {
        if (!text.trim()) {
          return [];
        }
        const result = await invokeModel({
          inputText: text,
          ...(isTitanV2(model) ? { dimensions: 1024, normalize: true } : {}),
        });
        return (result.embedding as number[]) ?? [];
      }),
    );
    return results;
  };

  const client: BedrockEmbeddingClient = { region, model };

  return {
    provider: {
      id: "bedrock",
      model,
      maxInputTokens: BEDROCK_MAX_INPUT_TOKENS[model],
      embedQuery,
      embedBatch,
    },
    client,
  };
}
