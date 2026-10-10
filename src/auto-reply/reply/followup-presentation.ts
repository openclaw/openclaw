import { formatErrorMessage } from "../../infra/errors.js";
import { defaultRuntime } from "../../runtime.js";
import type { GetReplyOptions } from "../get-reply-options.types.js";

export async function settleQueuedFollowupPresentation(
  onQueuedFollowupSettled: GetReplyOptions["onQueuedFollowupSettled"],
): Promise<void> {
  try {
    await onQueuedFollowupSettled?.();
  } catch (error) {
    defaultRuntime.error?.(
      `followup queue: queued presentation cleanup failed: ${formatErrorMessage(error)}`,
    );
  }
}
