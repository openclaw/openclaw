import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

export const FsWriteParamsSchema = Type.Object(
  {
    path: NonEmptyString,
    content: NonEmptyString,
  },
  { additionalProperties: false },
);

export type FsWriteParams = {
  path: string;
  /** Base64-encoded bytes to write. */
  content: string;
};
