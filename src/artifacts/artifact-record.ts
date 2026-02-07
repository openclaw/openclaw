import { z } from "zod";

/**
 * Full ArtifactRecord schema — the canonical metadata for any artifact in the store.
 *
 * Aligns with the "Artifact Store (cold state)" spec from the performance optimization docs:
 * - artifact_id: content-addressable (SHA256 hex)
 * - type: semantic classification
 * - content_uri: storage location (file:// / s3:// / local://)
 * - content_hash: SHA256 for integrity verification
 * - size_bytes: exact byte count
 * - created_at: ISO timestamp
 * - producer: who created the artifact
 * - summary: optional 1-2 line description
 */

export const ArtifactTypeSchema = z.enum(["code", "doc", "data", "log", "plan", "result", "repo"]);

export type ArtifactType = z.infer<typeof ArtifactTypeSchema>;

export const ArtifactProducerSchema = z.enum(["dispatcher", "executor", "planner", "system"]);

export type ArtifactProducer = z.infer<typeof ArtifactProducerSchema>;

export const ArtifactRecordSchema = z
  .object({
    artifact_id: z
      .string()
      .min(1)
      .regex(/^[a-f0-9]{64}$/, "artifact_id must be a 64-char lowercase hex SHA256"),
    type: ArtifactTypeSchema,
    content_uri: z.string().min(1),
    content_hash: z
      .string()
      .regex(/^[a-f0-9]{64}$/, "content_hash must be a 64-char lowercase hex SHA256"),
    size_bytes: z.number().int().nonnegative(),
    created_at: z.string().min(1), // ISO 8601
    producer: ArtifactProducerSchema.optional().default("system"),
    summary: z.string().max(500).optional(),
    mime: z.string().optional(),
  })
  .strict();

export type ArtifactRecord = z.infer<typeof ArtifactRecordSchema>;

/**
 * Validate an ArtifactRecord. Throws on invalid input (fail closed).
 */
export function validateArtifactRecord(input: unknown): ArtifactRecord {
  return ArtifactRecordSchema.parse(input);
}

/**
 * Safely validate an ArtifactRecord. Returns null on invalid input.
 */
export function safeValidateArtifactRecord(
  input: unknown,
): { success: true; data: ArtifactRecord } | { success: false; error: string } {
  const result = ArtifactRecordSchema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
  };
}

/**
 * Build an ArtifactRecord from ArtifactMeta (the internal registry format)
 * and a storage URI.
 */
export function buildArtifactRecordFromMeta(params: {
  meta: { id: string; mime: string; createdAt: string; sha256: string; sizeBytes: number };
  storageUri: string;
  type: ArtifactType;
  producer?: ArtifactProducer;
  summary?: string;
}): ArtifactRecord {
  return validateArtifactRecord({
    artifact_id: params.meta.id,
    type: params.type,
    content_uri: params.storageUri,
    content_hash: params.meta.sha256,
    size_bytes: params.meta.sizeBytes,
    created_at: params.meta.createdAt,
    producer: params.producer ?? "system",
    summary: params.summary,
    mime: params.meta.mime,
  });
}
