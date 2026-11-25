import { readStringOrNumberParam } from "../../../agents/tools/common.js";

export function resolveReactionMessageId(params: {
  args: Record<string, unknown>;
  toolContext?: { currentMessageId?: string | number };
}): string | number | undefined {
  return readStringOrNumberParam(params.args, "messageId") ?? params.toolContext?.currentMessageId;
}
