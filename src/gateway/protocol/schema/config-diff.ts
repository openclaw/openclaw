import { Type } from "typebox";

export const ConfigDiffEntryTypeSchema = Type.Union([
  Type.Literal("added"),
  Type.Literal("removed"),
  Type.Literal("changed"),
]);

export const ConfigDiffEntrySchema = Type.Object(
  {
    path: Type.String(),
    type: ConfigDiffEntryTypeSchema,
    before: Type.Optional(Type.Unknown()),
    after: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

export const ConfigChangedEventPayloadSchema = Type.Object(
  {
    changes: Type.Array(ConfigDiffEntrySchema),
    changedAt: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
