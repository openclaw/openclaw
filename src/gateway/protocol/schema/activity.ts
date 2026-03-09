import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

export const SessionActivityParamsSchema = Type.Object(
  {
    key: Type.Optional(NonEmptyString),
    keys: Type.Optional(Type.Array(NonEmptyString, { minItems: 1 })),
  },
  { additionalProperties: false },
);
