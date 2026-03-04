import { readStringOrNumberParam } from "../../../agents/tools/common.js";

type ReactionToolContext = {
  currentMessageId?: string | number;
};

export function resolveReactionMessageId(params: {
  args: Record<string, unknown>;
  toolContext?: ReactionToolContext;
}): string | number | undefined {
  const raw =
    readStringOrNumberParam(params.args, "messageId") ?? params.toolContext?.currentMessageId;
  if (typeof raw === "string") {
    return raw.split(":reaction:")[0];
  }
  return raw;
}
