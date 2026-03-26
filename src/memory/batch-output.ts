function decodeBase64Embedding(b64: string): number[] {
  const binary = Buffer.from(b64, "base64");
  const floats = new Float32Array(binary.buffer, binary.byteOffset, binary.byteLength / 4);
  return Array.from(floats);
}

export type EmbeddingBatchOutputLine = {
  custom_id?: string;
  error?: { message?: string };
  response?: {
    status_code?: number;
    body?:
      | {
          data?: Array<{
            embedding?: number[] | string;
          }>;
          error?: { message?: string };
        }
      | string;
  };
};

export function applyEmbeddingBatchOutputLine(params: {
  line: EmbeddingBatchOutputLine;
  remaining: Set<string>;
  errors: string[];
  byCustomId: Map<string, number[]>;
  encodingFormat?: "float" | "base64";
}) {
  const customId = params.line.custom_id;
  if (!customId) {
    return;
  }
  params.remaining.delete(customId);

  const errorMessage = params.line.error?.message;
  if (errorMessage) {
    params.errors.push(`${customId}: ${errorMessage}`);
    return;
  }

  const response = params.line.response;
  const statusCode = response?.status_code ?? 0;
  if (statusCode >= 400) {
    const messageFromObject =
      response?.body && typeof response.body === "object"
        ? (response.body as { error?: { message?: string } }).error?.message
        : undefined;
    const messageFromString = typeof response?.body === "string" ? response.body : undefined;
    params.errors.push(`${customId}: ${messageFromObject ?? messageFromString ?? "unknown error"}`);
    return;
  }

  const data =
    response?.body && typeof response.body === "object" ? (response.body.data ?? []) : [];
  const rawEmbedding = data[0]?.embedding;
  if (!rawEmbedding) {
    params.errors.push(`${customId}: empty embedding`);
    return;
  }

  // Handle base64 encoded embeddings
  const embedding =
    params.encodingFormat === "base64" && typeof rawEmbedding === "string"
      ? decodeBase64Embedding(rawEmbedding)
      : (rawEmbedding as number[]);

  if (embedding.length === 0) {
    params.errors.push(`${customId}: empty embedding`);
    return;
  }
  params.byCustomId.set(customId, embedding);
}
