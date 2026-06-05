// Channel action schemas describe plugin-declared actions available through channel UIs.
import { Type } from "typebox";
import type { TSchema } from "typebox";
import { stringEnum as createStringEnum } from "../agents/schema/typebox.js";

export {
  createUnionActionGate,
  listTokenSourcedAccounts,
} from "../channels/plugins/actions/shared.js";
export { resolveReactionMessageId } from "../channels/plugins/actions/reaction-message-id.js";
export {
  createActionGate,
  imageResultFromFile,
  jsonResult,
  readNonNegativeIntegerParam,
  parseAvailableTags,
  readNumberParam,
  readPositiveIntegerParam,
  readReactionParams,
  readStringArrayParam,
  readStringOrNumberParam,
  readStringParam,
  ToolAuthorizationError,
} from "../agents/tools/common.js";
export type { ActionGate } from "../agents/tools/common.js";
export { withNormalizedTimestamp } from "../agents/date-time.js";
export { assertMediaNotDataUrl } from "../agents/sandbox-paths.js";
export { resolvePollMaxSelections } from "../polls.js";
export {
  optionalFiniteNumberSchema,
  optionalNonNegativeIntegerSchema,
  optionalPositiveIntegerSchema,
  optionalStringEnum,
  stringEnum,
} from "../agents/schema/typebox.js";

export type ChannelPagedActionResult<TItemsKey extends string = "items", TItem = unknown> = {
  ok: true;
  complete: boolean;
  hasMore: boolean;
  returnedCount: number;
  source: string;
  query?: Record<string, unknown>;
  nextCursor?: string;
} & {
  [K in TItemsKey]: readonly TItem[];
} & Record<string, unknown>;

export function createChannelPagedActionResult<TItemsKey extends string, TItem>(params: {
  itemsKey: TItemsKey;
  items: readonly TItem[];
  source: string;
  hasMore?: boolean;
  query?: Record<string, unknown>;
  nextCursor?: string;
  nextCursorKey?: string;
  extra?: Record<string, unknown>;
}): ChannelPagedActionResult<TItemsKey, TItem> {
  const hasMore = params.hasMore === true;
  const nextCursor = hasMore && params.nextCursor?.trim() ? params.nextCursor.trim() : undefined;
  return {
    ...params.extra,
    ok: true,
    [params.itemsKey]: params.items,
    complete: !hasMore,
    hasMore,
    returnedCount: params.items.length,
    source: params.source,
    ...(params.query ? { query: params.query } : {}),
    ...(nextCursor ? { nextCursor } : {}),
    ...(nextCursor && params.nextCursorKey && params.nextCursorKey !== "nextCursor"
      ? { [params.nextCursorKey]: nextCursor }
      : {}),
  } as ChannelPagedActionResult<TItemsKey, TItem>;
}

/**
 * @deprecated Use semantic `presentation` capabilities instead of exposing
 * provider-native button schemas through the shared message tool.
 */
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

/**
 * @deprecated Use semantic `presentation` capabilities instead of exposing
 * provider-native card schemas through the shared message tool.
 */
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
