import { prepareReplyRunContext } from "./get-reply-run-context.js";
import { baseParams } from "./get-reply-run.test-support.js";

export async function prepareReadyReply(overrides: Parameters<typeof baseParams>[0]) {
  const prepared = await prepareReplyRunContext(baseParams(overrides));
  if (prepared.kind !== "ready") {
    throw new Error("Expected prepared reply context");
  }
  return prepared;
}
