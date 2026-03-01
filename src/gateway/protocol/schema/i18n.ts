import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

// BCP-47 subset (letters/numbers/hyphen) plus runtime canonicalization.
export const ControlUiLocaleCodeSchema = Type.String({
  minLength: 2,
  maxLength: 64,
  pattern: "^[A-Za-z0-9-]+$",
});

const ControlUiI18nJobStatusSchema = Type.String({
  enum: ["queued", "running", "completed", "failed"],
});

export const ControlUiI18nListParamsSchema = Type.Object({}, { additionalProperties: false });

export const ControlUiI18nGeneratedLocaleSchema = Type.Object(
  {
    locale: ControlUiLocaleCodeSchema,
    generatedAtMs: Type.Integer({ minimum: 0 }),
    updatedAtMs: Type.Integer({ minimum: 0 }),
    sourceHash: Type.String(),
    stale: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const ControlUiI18nJobSchema = Type.Object(
  {
    jobId: NonEmptyString,
    locale: ControlUiLocaleCodeSchema,
    status: ControlUiI18nJobStatusSchema,
    requestedAtMs: Type.Integer({ minimum: 0 }),
    startedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    finishedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    error: Type.Optional(Type.String()),
    requesterConnId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ControlUiI18nListResultSchema = Type.Object(
  {
    sourceLocale: Type.Literal("en"),
    sourceHash: Type.String(),
    generatedLocales: Type.Array(ControlUiI18nGeneratedLocaleSchema),
    jobs: Type.Array(ControlUiI18nJobSchema),
  },
  { additionalProperties: false },
);

export const ControlUiI18nGetParamsSchema = Type.Object(
  {
    locale: ControlUiLocaleCodeSchema,
  },
  { additionalProperties: false },
);

export const ControlUiI18nGetResultSchema = Type.Object(
  {
    locale: ControlUiLocaleCodeSchema,
    sourceLocale: Type.Literal("en"),
    sourceHash: Type.String(),
    stale: Type.Boolean(),
    generatedAtMs: Type.Integer({ minimum: 0 }),
    translation: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);

export const ControlUiI18nGenerateParamsSchema = Type.Object(
  {
    locale: ControlUiLocaleCodeSchema,
    force: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const ControlUiI18nGenerateResultSchema = Type.Object(
  {
    accepted: Type.Literal(true),
    deduped: Type.Optional(Type.Boolean()),
    job: Type.Object(
      {
        jobId: NonEmptyString,
        locale: ControlUiLocaleCodeSchema,
        status: Type.String({ enum: ["queued", "running"] }),
        requestedAtMs: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
