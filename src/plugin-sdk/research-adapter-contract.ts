/** Versioned semantic contract over existing plugin RPC; this is not an adapter registry. */
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
const text = (maxLength: number) => Type.String({ minLength: 1, maxLength });
export const researchAdapterHandleSchema = Type.Record(Type.String(), text(2_048), {
  maxProperties: 8,
});
export const researchAdapterRequestSchema = Type.Union([
  Type.Object(
    { version: Type.Literal(1), action: Type.Literal("describe") },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      action: Type.Literal("start"),
      question: text(8_000),
      output: Type.Optional(text(2_000)),
      asOf: Type.Optional(text(64)),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      action: Type.Union([Type.Literal("poll"), Type.Literal("cancel")]),
      handle: researchAdapterHandleSchema,
    },
    { additionalProperties: false },
  ),
]);
export const researchAdapterDescriptorSchema = Type.Object(
  {
    version: Type.Literal(1),
    kind: Type.Literal("managed-research"),
    provider: text(64),
    agent: text(256),
    authModes: Type.Array(Type.String()),
    citationEvidence: Type.Literal("provider-attributed"),
    storageRequired: Type.Boolean(),
    hardBudgets: Type.Object({
      model: Type.Boolean(),
      search: Type.Boolean(),
      tokens: Type.Boolean(),
    }),
    idempotentStart: Type.Boolean(),
  },
  { additionalProperties: false },
);
export const researchAdapterSnapshotSchema = Type.Object(
  {
    state: Type.Union([
      Type.Literal("running"),
      Type.Literal("completed"),
      Type.Literal("partial"),
      Type.Literal("failed"),
      Type.Literal("cancelled"),
      Type.Literal("blocked"),
      Type.Literal("indeterminate"),
    ]),
    handle: researchAdapterHandleSchema,
    report: Type.Optional(Type.String({ maxLength: 262_144 })),
    citations: Type.Array(
      Type.Object(
        {
          url: text(8_192),
          title: Type.Optional(Type.String({ maxLength: 1_024 })),
          startByte: Type.Optional(Type.Integer({ minimum: 0 })),
          endByte: Type.Optional(Type.Integer({ minimum: 0 })),
        },
        { additionalProperties: false },
      ),
      { maxItems: 256 },
    ),
    usageTokens: Type.Optional(Type.Integer({ minimum: 0 })),
    reason: Type.Optional(text(2_048)),
    retryAfterMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 3_600_000 })),
  },
  { additionalProperties: false },
);
export const researchAdapterReplySchema = Type.Union([
  Type.Object(
    {
      version: Type.Literal(1),
      ok: Type.Literal(true),
      value: Type.Union([researchAdapterDescriptorSchema, researchAdapterSnapshotSchema]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      version: Type.Literal(1),
      ok: Type.Literal(false),
      state: Type.Union([
        Type.Literal("blocked"),
        Type.Literal("failed"),
        Type.Literal("indeterminate"),
      ]),
      reason: text(2_048),
      handle: Type.Optional(researchAdapterHandleSchema),
      retryAfterMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 3_600_000 })),
    },
    { additionalProperties: false },
  ),
]);
export type ResearchAdapterRequest = Static<typeof researchAdapterRequestSchema>;
export type ResearchAdapterSnapshot = Static<typeof researchAdapterSnapshotSchema>;
export type ResearchAdapterReply = Static<typeof researchAdapterReplySchema>;
export type ResearchAdapterDescriptor = Static<typeof researchAdapterDescriptorSchema>;

/** Typed ingress check for the versioned request; schemas are owned by this contract. */
export function isResearchAdapterRequest(value: unknown): value is ResearchAdapterRequest {
  return Check(researchAdapterRequestSchema, value);
}
