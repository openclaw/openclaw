import { readStringOrNumberParam } from "../../../agents/tools/common.js";

type ReactionToolContext = {
  currentMessageId?: string | number;
};

export function resolveReactionMessageId(params: {
  args: Record<string, unknown>;
  toolContext?: ReactionToolContext;
}): string | number | undefined {
  return readStringOrNumberParam(params.args, "messageId") ?? params.toolContext?.currentMessageId;
}
