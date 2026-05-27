export {
  createUnionActionGate,
  listTokenSourcedAccounts,
} from "../channels/plugins/actions/shared.js";
export { resolveReactionMessageId } from "../channels/plugins/actions/reaction-message-id.js";
export { optionalStringEnum, stringEnum } from "../agents/schema/typebox.js";
import { Type } from "@sinclair/typebox";
import type { TSchema } from "@sinclair/typebox";
import { stringEnum as createStringEnum } from "../agents/schema/typebox.js";

/** Schema helper for channels that expose button rows on the shared `message` tool. */
export function createMessageToolButtonsSchema(): TSchema {
  return Type.Optional(
    Type.Array(
      Type.Array(
        Type.Object({
          text: Type.String(),
          callback_data: Type.String(),
          style: Type.Optional(createStringEnum(["danger", "success", "primary"])),
        }),
      ),
      {
        description: "Button rows for channels that support button-style actions.",
      },
    ),
  );
}

/** Schema helper for channels that accept provider-native card payloads. */
export function createMessageToolCardSchema(): TSchema {
  return Type.Optional(
    Type.Object(
      {},
      {
        additionalProperties: true,
        description: "Structured card payload for channels that support card-style messages.",
      },
    ),
  );
}
