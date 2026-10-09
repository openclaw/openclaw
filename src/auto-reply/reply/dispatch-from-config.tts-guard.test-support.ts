import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ReplyPayload } from "../types.js";
import { dispatchReplyFromConfig } from "./dispatch-from-config.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";

const emptyConfig = {} as OpenClawConfig;

/** One dispatch of a final payload through the qa-channel, returning everything delivered. */
export async function deliverFinalWithMedia(
  payload: ReplyPayload,
): Promise<Array<{ kind: string; payload: ReplyPayload }>> {
  const delivered: Array<{ kind: string; payload: ReplyPayload }> = [];
  const dispatcher = createReplyDispatcher({
    deliver: async (deliveredPayload, info) => {
      delivered.push({ kind: info.kind, payload: deliveredPayload });
    },
  });
  await dispatchReplyFromConfig({
    ctx: buildTestCtx({ Provider: "qa-channel", Surface: "qa-channel" }),
    cfg: emptyConfig,
    dispatcher,
    replyResolver: async () => payload,
  });
  dispatcher.markComplete();
  await dispatcher.waitForIdle();
  return delivered;
}
