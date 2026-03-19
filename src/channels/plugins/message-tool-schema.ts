import { Type } from "@sinclair/typebox";
import type { TSchema } from "@sinclair/typebox";
import { stringEnum } from "../../agents/schema/typebox.js";

export function createMessageToolButtonsSchema(): TSchema {
  return Type.Array(
    Type.Array(
      Type.Object({
        text: Type.String(),
        callback_data: Type.String(),
        style: Type.Optional(stringEnum(["danger", "success", "primary"])),
      }),
    ),
    {
      description: "Button rows for channels that support button-style actions.",
    },
  );
}

export function createMessageToolCardSchema(): TSchema {
  return Type.Object(
    {},
    {
      additionalProperties: true,
      description: "Structured card payload for channels that support card-style messages.",
    },
  );
}
