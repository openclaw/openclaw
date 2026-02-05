import crypto from "node:crypto";
import type { GraphitiClient } from "../graphiti/client.js";
import type { EmbedderAdapter, VectorAdapter } from "../interfaces.js";
import type { MemoryAuditEvent, MemoryMetricEvent } from "../telemetry.js";
import type { MemoryContentObject } from "../types.js";
import type { EnrichHooks } from "./enrich.js";
import { createMemoryTraceLogger } from "../memory-log.js";
import {
  type IngestionPipelineContract,
  type IngestionStageResult,
  type MemoryIngestionStage,
  type PipelineError,
} from "./contracts.js";
import { embedEpisodes } from "./embed.js";
import { enrichEpisodes } from "./enrich.js";
import { extractEpisodesFromContent } from "./extract.js";
import { writeEpisodesToGraph } from "./graph.js";
import { indexEpisodes } from "./index.js";
import { normalizeIngestItems, type IngestItemInput } from "./normalize.js";

export type MemoryIngestRequest = {
  source?: string;
  sessionKey?: string;
  traceId?: string;
  items?: IngestItemInput[];
};

export type MemoryIngestWarning = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

export type MemoryIngestResult = {
  ok: boolean;
  runId: string;
  batchId: string;
  warnings: MemoryIngestWarning[];
  contract: IngestionPipelineContract;
};

export type MemoryIngestDependencies = {
  embedder?: EmbedderAdapter;
  vectorAdapter?: VectorAdapter;
  graphiti?: GraphitiClient;
  enrichHooks?: EnrichHooks;
  emitMetric?: (event: MemoryMetricEvent) => void;
  emitAudit?: (event: MemoryAuditEvent) => void;
  logger?: ReturnType<typeof createMemoryTraceLogger>;
  now?: () => Date;
};

function buildPipelineError(message: string, details?: Record<string, unknown>): PipelineError {
  return {
    code: "unknown",
    message,
    details,
    retryable: false,
  };
}

function emitMetric(deps: MemoryIngestDependencies, payload: Omit<MemoryMetricEvent, "ts">): void {
  const now = deps.now?.() ?? new Date();
  const event: MemoryMetricEvent = { ...payload, ts: now.toISOString() };
  if (deps.emitMetric) {
    deps.emitMetric(event);
    return;
  }
  deps.logger?.trace("memory.pipeline.metric", event as Record<string, unknown>);
}

function emitAudit(deps: MemoryIngestDependencies, payload: Omit<MemoryAuditEvent, "ts">): void {
  const now = deps.now?.() ?? new Date();
  const event: MemoryAuditEvent = { ...payload, ts: now.toISOString() };
  if (deps.emitAudit) {
    deps.emitAudit(event);
    return;
  }
  deps.logger?.trace("memory.pipeline.audit", event as Record<string, unknown>);
}

function stageToAuditAction(stage: MemoryIngestionStage): MemoryAuditEvent["action"] {
  switch (stage) {
    case "graph":
      return "graph_write";
    case "index":
      return "vector_write";
    default:
      return "ingest";
  }
}

export async function runMemoryIngestionPipeline(
  request: MemoryIngestRequest,
  deps: MemoryIngestDependencies = {},
): Promise<MemoryIngestResult> {
  const logger = deps.logger ?? createMemoryTraceLogger("memory.pipeline");
  const now = deps.now?.() ?? new Date();
  const runId = crypto.randomUUID();
  const batchId = crypto.randomUUID();
  const warnings: MemoryIngestWarning[] = [];
  const stageResults: IngestionStageResult[] = [];
  const stages: MemoryIngestionStage[] = [
    "normalize",
    "extract",
    "enrich",
    "embed",
    "graph",
    "index",
    "audit",
  ];
  const errors: PipelineError[] = [];

  const contract: IngestionPipelineContract = {
    stages,
    stageResults,
    errors,
    startedAt: now.toISOString(),
  };

  const runStage = async <T>(stage: MemoryIngestionStage, fn: () => Promise<T>) => {
    const start = Date.now();
    try {
      const output = await fn();
      const durationMs = Date.now() - start;
      stageResults.push({ stage, ok: true, durationMs });
      emitMetric(deps, {
        name: "memory.pipeline.events",
        value: 1,
        tags: { stage, status: "success" },
      });
      emitAudit(deps, {
        id: crypto.randomUUID(),
        action: stageToAuditAction(stage),
        sessionKey: request.sessionKey,
        traceId: request.traceId,
        status: "success",
        details: { stage, durationMs, batchId, runId },
      });
      return output;
    } catch (err) {
      const durationMs = Date.now() - start;
      const errorMessage = err instanceof Error ? err.message : String(err);
      const error = buildPipelineError(errorMessage, { stage });
      errors.push(error);
      stageResults.push({ stage, ok: false, durationMs, error });
      emitMetric(deps, {
        name: "memory.pipeline.errors",
        value: 1,
        tags: { stage, status: "failure" },
      });
      emitAudit(deps, {
        id: crypto.randomUUID(),
        action: stageToAuditAction(stage),
        sessionKey: request.sessionKey,
        traceId: request.traceId,
        status: "failure",
        details: { stage, durationMs, batchId, runId, error: errorMessage },
      });
      throw err;
    }
  };

  let normalized: MemoryContentObject[] = [];
  let episodes: MemoryContentObject[] = [];
  let embeddings = new Map<string, number[]>();

  try {
    normalized = await runStage("normalize", async () =>
      normalizeIngestItems({
        items: request.items,
        source: request.source,
        sessionKey: request.sessionKey,
        traceId: request.traceId,
      }),
    );

    const extractResult = await runStage("extract", async () =>
      extractEpisodesFromContent(normalized),
    );
    warnings.push(...extractResult.warnings);
    episodes = extractResult.episodes;

    const enrichResult = await runStage("enrich", async () =>
      enrichEpisodes(episodes, deps.enrichHooks),
    );
    warnings.push(...enrichResult.warnings);
    episodes = enrichResult.episodes;

    const embedResult = await runStage("embed", async () =>
      embedEpisodes({ episodes, embedder: deps.embedder }),
    );
    warnings.push(...embedResult.warnings);
    embeddings = embedResult.embeddings;

    const graphResult = await runStage("graph", async () =>
      writeEpisodesToGraph({ episodes, client: deps.graphiti }),
    );
    warnings.push(...graphResult.warnings);

    const indexResult = await runStage("index", async () =>
      indexEpisodes({ episodes, embeddings, vectorAdapter: deps.vectorAdapter }),
    );
    warnings.push(...indexResult.warnings);

    await runStage("audit", async () => {
      logger.summary("memory ingestion pipeline complete", {
        runId,
        batchId,
        episodes: episodes.length,
        warnings: warnings.length,
      });
      return undefined;
    });
  } catch (err) {
    logger.warn("memory ingestion pipeline failed", {
      runId,
      batchId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const completedAt = deps.now?.() ?? new Date();
  contract.completedAt = completedAt.toISOString();

  emitMetric(deps, {
    name: "memory.ingest.duration_ms",
    value: completedAt.getTime() - now.getTime(),
    tags: { runId, batchId },
  });

  return {
    ok: errors.length === 0,
    runId,
    batchId,
    warnings,
    contract,
  };
}
