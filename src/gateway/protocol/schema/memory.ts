import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

const MemorySourceSchema = Type.Union([Type.Literal("memory"), Type.Literal("sessions")]);
const MemoryCorpusSchema = Type.Union([
  Type.Literal("memory"),
  Type.Literal("sessions"),
  Type.Literal("all"),
]);
const MemoryIndexJobStatusSchema = Type.Union([
  Type.Literal("running"),
  Type.Literal("completed"),
  Type.Literal("failed"),
]);

export const MemoryRpcScopeSchema = Type.Object(
  {
    requesterAgentId: NonEmptyString,
    allowedAgentIds: Type.Array(NonEmptyString),
    crossAgent: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const MemoryStatusParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    probe: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const MemorySourcesListParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
  },
  { additionalProperties: false },
);

export const MemorySearchDebugParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    query: NonEmptyString,
    maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    minScore: Type.Optional(Type.Number()),
    corpus: Type.Optional(MemoryCorpusSchema),
  },
  { additionalProperties: false },
);

export const MemoryIndexRunParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    force: Type.Optional(Type.Boolean()),
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const MemoryIndexJobsParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false },
);

export const MemorySourceOpenParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    sourceRef: NonEmptyString,
    from: Type.Optional(Type.Integer({ minimum: 1 })),
    lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  },
  { additionalProperties: false },
);

const MemorySourceCountSchema = Type.Object(
  {
    source: MemorySourceSchema,
    files: Type.Integer({ minimum: 0 }),
    chunks: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

const MemoryStatusVectorSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    available: Type.Optional(Type.Boolean()),
    dims: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

const MemoryStatusFtsSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    available: Type.Boolean(),
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const MemoryStatusFallbackSchema = Type.Object(
  {
    from: NonEmptyString,
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const MemoryProviderStatusPublicSchema = Type.Object(
  {
    backend: Type.String(),
    provider: Type.String(),
    model: Type.Optional(Type.String()),
    files: Type.Optional(Type.Integer({ minimum: 0 })),
    chunks: Type.Optional(Type.Integer({ minimum: 0 })),
    dirty: Type.Optional(Type.Boolean()),
    sources: Type.Optional(Type.Array(MemorySourceSchema)),
    sourceCounts: Type.Optional(Type.Array(MemorySourceCountSchema)),
    cache: Type.Optional(Type.Unknown()),
    fts: Type.Optional(MemoryStatusFtsSchema),
    vector: Type.Optional(MemoryStatusVectorSchema),
    batch: Type.Optional(Type.Unknown()),
    fallback: Type.Optional(MemoryStatusFallbackSchema),
  },
  { additionalProperties: false },
);

export const MemoryStatusResultSchema = Type.Object(
  {
    requesterAgentId: NonEmptyString,
    scope: MemoryRpcScopeSchema,
    agents: Type.Array(
      Type.Object(
        {
          agentId: NonEmptyString,
          status: MemoryProviderStatusPublicSchema,
          embedding: Type.Optional(Type.Union([Type.Unknown(), Type.Null()])),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const MemorySourcesListResultSchema = Type.Object(
  {
    requesterAgentId: NonEmptyString,
    scope: MemoryRpcScopeSchema,
    agents: Type.Array(
      Type.Object(
        {
          agentId: NonEmptyString,
          sources: Type.Array(MemorySourceCountSchema),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

const MemoryOpenTargetSchema = Type.Object(
  {
    kind: Type.Literal("memory-source"),
    sourceRef: NonEmptyString,
    line: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

const MemorySearchDebugHitSchema = Type.Object(
  {
    path: NonEmptyString,
    sourcePath: NonEmptyString,
    source_path: NonEmptyString,
    startLine: Type.Optional(Type.Integer({ minimum: 1 })),
    endLine: Type.Optional(Type.Integer({ minimum: 1 })),
    start_line: Type.Optional(Type.Integer({ minimum: 1 })),
    end_line: Type.Optional(Type.Integer({ minimum: 1 })),
    score: Type.Number(),
    vectorScore: Type.Optional(Type.Number()),
    textScore: Type.Optional(Type.Number()),
    snippet: Type.Optional(Type.String()),
    source: Type.Optional(MemorySourceSchema),
    citation: Type.Optional(Type.String()),
    matchType: Type.Optional(Type.String()),
    agentId: NonEmptyString,
    agent_id: NonEmptyString,
    sourceRef: NonEmptyString,
    openTarget: MemoryOpenTargetSchema,
  },
  { additionalProperties: false },
);

export const MemorySearchDebugResultSchema = Type.Object(
  {
    requesterAgentId: NonEmptyString,
    scope: MemoryRpcScopeSchema,
    query: NonEmptyString,
    results: Type.Array(MemorySearchDebugHitSchema),
    debug: Type.Object(
      {
        searchMs: Type.Integer({ minimum: 0 }),
        hits: Type.Integer({ minimum: 0 }),
        runtime: Type.Array(Type.Unknown()),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const MemoryIndexJobSchema = Type.Object(
  {
    jobId: NonEmptyString,
    requesterAgentId: NonEmptyString,
    agentIds: Type.Array(NonEmptyString),
    status: MemoryIndexJobStatusSchema,
    force: Type.Boolean(),
    reason: Type.String(),
    createdAtMs: Type.Integer({ minimum: 0 }),
    updatedAtMs: Type.Integer({ minimum: 0 }),
    error: Type.Optional(Type.String()),
    progress: Type.Optional(
      Type.Object(
        {
          completed: Type.Integer({ minimum: 0 }),
          total: Type.Integer({ minimum: 0 }),
          label: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const MemoryIndexRunResultSchema = Type.Object(
  {
    job: MemoryIndexJobSchema,
  },
  { additionalProperties: false },
);

export const MemoryIndexJobsResultSchema = Type.Object(
  {
    requesterAgentId: NonEmptyString,
    jobs: Type.Array(MemoryIndexJobSchema),
  },
  { additionalProperties: false },
);

export const MemorySourceOpenResultSchema = Type.Object(
  {
    sourceRef: NonEmptyString,
    agentId: NonEmptyString,
    source: Type.Optional(MemorySourceSchema),
    path: NonEmptyString,
    from: Type.Optional(Type.Integer({ minimum: 1 })),
    lines: Type.Optional(Type.Integer({ minimum: 1 })),
    text: Type.String(),
    truncated: Type.Optional(Type.Boolean()),
    nextFrom: Type.Optional(Type.Integer({ minimum: 1 })),
    openTarget: MemoryOpenTargetSchema,
  },
  { additionalProperties: false },
);
