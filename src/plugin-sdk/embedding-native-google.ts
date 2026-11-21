import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { formatEmbeddingTaskText } from "../../packages/memory-host-sdk/src/host/embedding-inputs.js";
import { sanitizeAndNormalizeEmbedding } from "../../packages/memory-host-sdk/src/host/embedding-vectors.js";
import { normalizeEmbeddingModelWithPrefixes } from "../../packages/memory-host-sdk/src/host/embeddings-model-normalize.js";
import type { EmbeddingInput } from "../plugins/embedding-provider-runtime-types.js";

export const DEFAULT_GEMINI_EMBEDDING_MODEL = "gemini-embedding-001";
export const GEMINI_MAX_INPUT_TOKENS: Record<string, number> = {
  "gemini-embedding-001": 2048,
  "gemini-embedding-2": 8192,
  "gemini-embedding-2-preview": 8192,
};

type GeminiTaskType = string;

const GEMINI_EMBEDDING_2_MODELS = new Set(["gemini-embedding-2", "gemini-embedding-2-preview"]);

const GEMINI_EMBEDDING_2_DEFAULT_DIMENSIONS = 3072;
export type GeminiEmbeddingRequest = {
  content: { parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> };
  taskType?: GeminiTaskType;
  outputDimensionality?: number;
  model?: string;
};

function malformedGeminiEmbeddingResponse(): Error {
  return new Error("gemini embeddings failed: malformed JSON response");
}

function unexpectedGeminiEmbeddingDimensions(expected: number, actual: number): Error {
  return new Error(`gemini embeddings failed: expected ${expected} dimensions, received ${actual}`);
}

/** Direct and downloaded vectors share one invariant before normalization. */
export function isValidGeminiEmbeddingValues(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  );
}

export function readGeminiEmbeddingValues(embedding: unknown): number[] {
  const value = asOptionalRecord(embedding)?.values;
  if (!isValidGeminiEmbeddingValues(value)) {
    throw malformedGeminiEmbeddingResponse();
  }
  return value;
}

export function readGeminiBatchEmbeddings(
  payload: Record<string, unknown>,
  expectedCount: number,
): number[][] {
  if (!Array.isArray(payload.embeddings) || payload.embeddings.length !== expectedCount) {
    throw malformedGeminiEmbeddingResponse();
  }
  return payload.embeddings.map(readGeminiEmbeddingValues);
}

export function buildGeminiEmbeddingRequest(params: {
  input: EmbeddingInput;
  model: string;
  role: "query" | "document";
  queryInstructionApplied?: boolean;
  documentFormatApplied?: boolean;
  taskType: GeminiTaskType;
  outputDimensionality?: number;
  modelPath?: string;
}): GeminiEmbeddingRequest {
  const input = typeof params.input === "string" ? { text: params.input } : params.input;
  const parts: GeminiEmbeddingRequest["content"]["parts"] = input.parts?.map((part) =>
    part.type === "text"
      ? { text: part.text }
      : {
          inlineData: { mimeType: part.mimeType, data: part.data },
        },
  ) ?? [{ text: input.text }];
  const isStableEmbedding2 = normalizeGeminiModel(params.model) === "gemini-embedding-2";
  const request: GeminiEmbeddingRequest = { content: { parts } };
  if (
    isStableEmbedding2 &&
    !(params.role === "query" ? params.queryInstructionApplied : params.documentFormatApplied) &&
    parts.every((part) => "text" in part)
  ) {
    const first = parts[0];
    if (first && "text" in first) {
      const taskType =
        params.role === "document" &&
        (params.taskType === "RETRIEVAL_QUERY" ||
          params.taskType === "QUESTION_ANSWERING" ||
          params.taskType === "FACT_VERIFICATION")
          ? "RETRIEVAL_DOCUMENT"
          : params.taskType;
      first.text = formatEmbeddingTaskText(first.text, taskType);
    }
  } else if (!isStableEmbedding2) {
    request.taskType = params.taskType;
  }
  if (params.modelPath) {
    request.model = params.modelPath;
  }
  if (params.outputDimensionality != null) {
    request.outputDimensionality = params.outputDimensionality;
  }
  return request;
}

/** Returns true for Gemini Embedding 2 variants with multimodal and extended task support. */
export function isGeminiEmbedding2Model(model: string): boolean {
  return GEMINI_EMBEDDING_2_MODELS.has(normalizeGeminiModel(model));
}

export function resolveGeminiOutputDimensionality(
  model: string,
  requested?: number,
): number | undefined {
  const isEmbedding2 = isGeminiEmbedding2Model(model);
  if (!isEmbedding2 && model !== DEFAULT_GEMINI_EMBEDDING_MODEL) {
    return undefined;
  }
  if (requested == null) {
    return isEmbedding2 ? GEMINI_EMBEDDING_2_DEFAULT_DIMENSIONS : undefined;
  }
  if (!Number.isInteger(requested) || requested < 128 || requested > 3072) {
    throw new Error(
      `Invalid outputDimensionality ${requested} for ${model}. Use an integer between 128 and 3072.`,
    );
  }
  return requested;
}
export function normalizeGeminiModel(model: string): string {
  return normalizeEmbeddingModelWithPrefixes({
    model,
    defaultModel: DEFAULT_GEMINI_EMBEDDING_MODEL,
    prefixes: ["models/gemini/", "models/google/", "models/", "gemini/", "google/"],
  });
}

export function sanitizeGeminiEmbedding(values: number[], expectedDimensions?: number): number[] {
  if (expectedDimensions != null && values.length !== expectedDimensions) {
    throw unexpectedGeminiEmbeddingDimensions(expectedDimensions, values.length);
  }
  return sanitizeAndNormalizeEmbedding(values);
}
