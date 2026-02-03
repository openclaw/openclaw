import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

export const ModelChoiceSchema = Type.Object(
  {
    id: NonEmptyString,
    name: NonEmptyString,
    provider: NonEmptyString,
    contextWindow: Type.Optional(Type.Integer({ minimum: 1 })),
    reasoning: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const AgentIdentitySchema = Type.Object(
  {
    name: Type.Optional(NonEmptyString),
    theme: Type.Optional(NonEmptyString),
    emoji: Type.Optional(NonEmptyString),
    avatar: Type.Optional(NonEmptyString),
    avatarUrl: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const AgentSummarySchema = Type.Object(
  {
    id: NonEmptyString,
    name: Type.Optional(NonEmptyString),
    model: Type.Optional(NonEmptyString),
    runtime: Type.Optional(Type.Union([Type.Literal("pi"), Type.Literal("claude")])),
    workspace: Type.Optional(NonEmptyString),
    agentDir: Type.Optional(NonEmptyString),
    toolRestrictions: Type.Optional(
      Type.Object(
        {
          allow: Type.Optional(Type.Array(NonEmptyString)),
          deny: Type.Optional(Type.Array(NonEmptyString)),
        },
        { additionalProperties: false },
      ),
    ),
    sandbox: Type.Optional(
      Type.Object(
        {
          mode: Type.Union([Type.Literal("off"), Type.Literal("non-main"), Type.Literal("all")]),
          scope: Type.Optional(
            Type.Union([Type.Literal("session"), Type.Literal("agent"), Type.Literal("shared")]),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    identity: Type.Optional(AgentIdentitySchema),
  },
  { additionalProperties: false },
);

export const AgentsListParamsSchema = Type.Object({}, { additionalProperties: false });

export const AgentsListResultSchema = Type.Object(
  {
    defaultId: NonEmptyString,
    mainKey: NonEmptyString,
    scope: Type.Union([Type.Literal("per-sender"), Type.Literal("global")]),
    agents: Type.Array(AgentSummarySchema),
  },
  { additionalProperties: false },
);

export const AgentsFileEntrySchema = Type.Object(
  {
    name: NonEmptyString,
    path: NonEmptyString,
    missing: Type.Boolean(),
    size: Type.Optional(Type.Integer({ minimum: 0 })),
    updatedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    content: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const AgentsFilesListParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const AgentsFilesListResultSchema = Type.Object(
  {
    agentId: NonEmptyString,
    workspace: NonEmptyString,
    files: Type.Array(AgentsFileEntrySchema),
  },
  { additionalProperties: false },
);

export const AgentsFilesGetParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    name: NonEmptyString,
  },
  { additionalProperties: false },
);

export const AgentsFilesGetResultSchema = Type.Object(
  {
    agentId: NonEmptyString,
    workspace: NonEmptyString,
    file: AgentsFileEntrySchema,
  },
  { additionalProperties: false },
);

export const AgentsFilesSetParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    name: NonEmptyString,
    content: Type.String(),
  },
  { additionalProperties: false },
);

export const AgentsFilesSetResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    agentId: NonEmptyString,
    workspace: NonEmptyString,
    file: AgentsFileEntrySchema,
  },
  { additionalProperties: false },
);

export const AgentsDescribeParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    includeFiles: Type.Optional(Type.Boolean()),
    includeSessions: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const AgentsDescribeResultSchema = Type.Object(
  {
    agentId: NonEmptyString,
    agent: AgentSummarySchema,
    bindings: Type.Array(Type.Unknown()),
    identity: Type.Optional(AgentIdentitySchema),
    files: Type.Optional(Type.Array(AgentsFileEntrySchema)),
    activeSessions: Type.Optional(
      Type.Object(
        {
          count: Type.Integer({ minimum: 0 }),
          lastActivityAt: Type.Optional(Type.Integer({ minimum: 0 })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const ModelsListParamsSchema = Type.Object({}, { additionalProperties: false });

export const ModelsListResultSchema = Type.Object(
  {
    models: Type.Array(ModelChoiceSchema),
  },
  { additionalProperties: false },
);

export const SkillsStatusParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const SkillsBinsParamsSchema = Type.Object({}, { additionalProperties: false });

export const SkillsBinsResultSchema = Type.Object(
  {
    bins: Type.Array(NonEmptyString),
  },
  { additionalProperties: false },
);

export const SkillsInstallParamsSchema = Type.Object(
  {
    name: NonEmptyString,
    installId: NonEmptyString,
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1000 })),
  },
  { additionalProperties: false },
);

export const SkillsUpdateParamsSchema = Type.Object(
  {
    skillKey: NonEmptyString,
    enabled: Type.Optional(Type.Boolean()),
    apiKey: Type.Optional(Type.String()),
    env: Type.Optional(Type.Record(NonEmptyString, Type.String())),
  },
  { additionalProperties: false },
);
