import { Type } from "typebox";
import type { TSchema } from "typebox";
import { stringEnum as createStringEnum } from "../agents/schema/typebox.js";
import type { ChannelMessageActionName } from "../channels/plugins/types.public.js";

export {
  createUnionActionGate,
  listTokenSourcedAccounts,
} from "../channels/plugins/actions/shared.js";
export { resolveReactionMessageId } from "../channels/plugins/actions/reaction-message-id.js";
export {
  createActionGate,
  imageResultFromFile,
  jsonResult,
  parseAvailableTags,
  readNumberParam,
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
export { optionalStringEnum, stringEnum } from "../agents/schema/typebox.js";

function readOptionalStringField(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (typeof value !== "string") {
    return undefined;
  }
  return value.trim() ? value : undefined;
}

function readOptionalMessageText(args: Record<string, unknown>): string {
  for (const key of ["message", "content", "caption"] as const) {
    const value = args[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return "";
}

export function resolveUploadFileActionAsSendMedia(params: {
  action: ChannelMessageActionName;
  args: Record<string, unknown>;
  channelLabel?: string;
}): { action: "send"; args: Record<string, unknown> } | null {
  if (params.action !== "upload-file") {
    return null;
  }
  const label = params.channelLabel?.trim() || "This channel";
  if (readOptionalStringField(params.args, "buffer")) {
    throw new Error(
      `${label} cannot lower upload-file buffer payloads to send+media. Use media, mediaUrl, filePath, path, or fileUrl instead.`,
    );
  }
  const media =
    readOptionalStringField(params.args, "media") ??
    readOptionalStringField(params.args, "mediaUrl") ??
    readOptionalStringField(params.args, "filePath") ??
    readOptionalStringField(params.args, "path") ??
    readOptionalStringField(params.args, "fileUrl");
  if (!media) {
    throw new Error(`${label} upload-file requires media, mediaUrl, filePath, path, or fileUrl.`);
  }
  return {
    action: "send",
    args: {
      ...params.args,
      action: "send",
      media,
      message: readOptionalMessageText(params.args),
    },
  };
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
