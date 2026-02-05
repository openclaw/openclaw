import crypto from "node:crypto";
import type {
  MemoryArtifact,
  MemoryContentObject,
  MemoryProvenance,
  MemoryTemporalMetadata,
} from "../types.js";

export type IngestItemInput = {
  id?: string;
  kind?: string;
  text?: string;
  metadata?: Record<string, unknown>;
};

export type NormalizeInput = {
  items?: IngestItemInput[];
  source?: string;
  sessionKey?: string;
  traceId?: string;
};

function buildProvenance(params: NormalizeInput): MemoryProvenance {
  return {
    source: params.source ?? "memory.ingest",
    sessionKey: params.sessionKey,
    traceId: params.traceId,
  };
}

function extractTemporal(metadata?: Record<string, unknown>): MemoryTemporalMetadata | undefined {
  if (!metadata) return undefined;
  const temporal = metadata.temporal;
  if (temporal && typeof temporal === "object") {
    return temporal as MemoryTemporalMetadata;
  }
  return undefined;
}

function extractArtifacts(metadata?: Record<string, unknown>): MemoryArtifact[] | undefined {
  if (!metadata) return undefined;
  const artifacts = metadata.artifacts;
  if (Array.isArray(artifacts)) {
    return artifacts.filter(
      (artifact): artifact is MemoryArtifact => !!artifact && typeof artifact === "object",
    );
  }
  return undefined;
}

export function normalizeIngestItems(params: NormalizeInput): MemoryContentObject[] {
  const provenance = buildProvenance(params);
  const items = params.items ?? [];

  return items.map((item) => {
    const temporal = extractTemporal(item.metadata);
    const artifacts = extractArtifacts(item.metadata);

    return {
      id: item.id ?? crypto.randomUUID(),
      kind: item.kind ?? "event",
      text: item.text,
      metadata: item.metadata,
      artifacts,
      provenance,
      temporal,
    } satisfies MemoryContentObject;
  });
}
