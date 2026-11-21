import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { sanitizeAndNormalizeEmbedding } from "../../packages/memory-host-sdk/src/host/embedding-vectors.js";

export type BedrockEmbeddingFamily =
  | "titan-v1"
  | "titan-v2"
  | "cohere-v3"
  | "cohere-v4"
  | "nova"
  | "marengo-2"
  | "marengo-3";

export interface BedrockEmbeddingSpec {
  maxTokens: number;
  dims: number;
  validDims?: number[];
  family: BedrockEmbeddingFamily;
}

const MODELS: Record<string, BedrockEmbeddingSpec> = {
  "amazon.titan-embed-text-v2:0": {
    maxTokens: 8192,
    dims: 1024,
    validDims: [256, 512, 1024],
    family: "titan-v2",
  },
  "amazon.titan-embed-text-v1": { maxTokens: 8000, dims: 1536, family: "titan-v1" },
  "amazon.titan-embed-g1-text-02": { maxTokens: 8000, dims: 1536, family: "titan-v1" },
  "amazon.titan-embed-image-v1": { maxTokens: 128, dims: 1024, family: "titan-v1" },
  "cohere.embed-english-v3": { maxTokens: 512, dims: 1024, family: "cohere-v3" },
  "cohere.embed-multilingual-v3": { maxTokens: 512, dims: 1024, family: "cohere-v3" },
  "cohere.embed-v4:0": {
    maxTokens: 128000,
    dims: 1536,
    validDims: [256, 512, 1024, 1536],
    family: "cohere-v4",
  },
  "amazon.nova-2-multimodal-embeddings-v1:0": {
    maxTokens: 8192,
    dims: 1024,
    validDims: [256, 384, 1024, 3072],
    family: "nova",
  },
  "twelvelabs.marengo-embed-2-7-v1:0": { maxTokens: 512, dims: 1024, family: "marengo-2" },
  "twelvelabs.marengo-embed-3-0-v1:0": { maxTokens: 512, dims: 512, family: "marengo-3" },
};

export function stripInferenceProfilePrefix(modelId: string): string {
  return modelId.replace(/^(?:us|eu|ap|apac|au|jp|global)\./, "");
}

/** Resolve spec, stripping throughput suffixes like `:2:8k` or `:0:512`. */
export function resolveBedrockEmbeddingSpec(modelId: string): BedrockEmbeddingSpec | undefined {
  const bare = stripInferenceProfilePrefix(modelId);
  if (Object.hasOwn(MODELS, bare)) {
    return MODELS[bare];
  }
  const parts = bare.split(":");
  for (let i = parts.length - 1; i >= 1; i--) {
    const spec = MODELS[parts.slice(0, i).join(":")];
    if (spec && Object.hasOwn(MODELS, parts.slice(0, i).join(":"))) {
      return spec;
    }
  }
  return undefined;
}

export function buildCohereEmbeddingBody(
  family: "cohere-v3" | "cohere-v4",
  texts: string[],
  inputType: "search_query" | "search_document",
  dimensions?: number,
): Record<string, unknown> {
  return {
    texts,
    input_type: inputType,
    truncate: family === "cohere-v4" ? "RIGHT" : "END",
    ...(family === "cohere-v4"
      ? {
          embedding_types: ["float"],
          ...(dimensions === undefined ? {} : { output_dimension: dimensions }),
        }
      : {}),
  };
}

export function buildBedrockEmbeddingBody(
  family: BedrockEmbeddingFamily,
  text: string,
  dims?: number,
): string {
  switch (family) {
    case "titan-v2": {
      const b: Record<string, unknown> = { inputText: text };
      if (dims != null) {
        b.dimensions = dims;
        b.normalize = true;
      }
      return JSON.stringify(b);
    }
    case "titan-v1":
      return JSON.stringify({ inputText: text });
    case "nova":
      return JSON.stringify({
        taskType: "SINGLE_EMBEDDING",
        singleEmbeddingParams: {
          embeddingPurpose: "GENERIC_INDEX",
          embeddingDimension: dims ?? 1024,
          text: { truncationMode: "END", value: text },
        },
      });
    case "marengo-2":
      return JSON.stringify({ inputType: "text", inputText: text });
    case "marengo-3":
      return JSON.stringify({ inputType: "text", text: { inputText: text } });
    default:
      return JSON.stringify({ inputText: text });
  }
}

type BedrockEmbeddingResponseJson = {
  embedding?: unknown;
  embeddings?: unknown;
  data?: unknown;
};

function parseEmbeddingResponseJson(raw: Uint8Array | undefined): BedrockEmbeddingResponseJson {
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Amazon Bedrock embedding response returned malformed JSON");
    }
    return asOptionalRecord(parsed) ?? {};
  } catch {
    throw new Error("Amazon Bedrock embedding response returned malformed JSON");
  }
}

function malformedBedrockEmbeddingResponse(): Error {
  return new Error("Amazon Bedrock embedding response returned malformed JSON");
}

function asNumberArray(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw malformedBedrockEmbeddingResponse();
  }
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      throw malformedBedrockEmbeddingResponse();
    }
  }
  return value;
}

export function readBedrockSingleEmbedding(
  family: BedrockEmbeddingFamily,
  raw: Uint8Array | undefined,
): number[] {
  const data = parseEmbeddingResponseJson(raw);
  switch (family) {
    case "nova":
      return asNumberArray(Array.isArray(data.embeddings) ? data.embeddings[0]?.embedding : null);
    case "marengo-2":
    case "marengo-3": {
      if (Array.isArray(data.data)) {
        return asNumberArray(asOptionalRecord(data.data[0])?.embedding);
      }
      const dataRecord = asOptionalRecord(data.data);
      if (dataRecord) {
        return asNumberArray(dataRecord.embedding);
      }
      return asNumberArray(data.embedding);
    }
    default:
      return asNumberArray(data.embedding);
  }
}

export function readCohereEmbeddingBatch(
  family: BedrockEmbeddingFamily,
  raw: Uint8Array | undefined,
): number[][] {
  const data = parseEmbeddingResponseJson(raw);
  const embeddings =
    family === "cohere-v4" && !Array.isArray(data.embeddings)
      ? asOptionalRecord(data.embeddings)?.float
      : data.embeddings;
  if (!Array.isArray(embeddings)) {
    throw malformedBedrockEmbeddingResponse();
  }
  return embeddings.map((embedding) => sanitizeAndNormalizeEmbedding(asNumberArray(embedding)));
}
