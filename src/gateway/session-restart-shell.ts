import { recordInterruptedShellNotice } from "../config/sessions/session-restart-recovery.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { getGatewayLifecycleRuntime } from "./server-lifecycle-runtime-context.js";
const notice =
  "The Gateway restarted before it could verify the result of a shell command. Its effect is unknown. I paused this turn without retrying the command. Check its outcome before sending a new request.";

export async function pauseInterruptedShellTurn(params: {
  target: { agentId: string; sessionKey: string; storePath: string; env?: NodeJS.ProcessEnv };
  entry: InternalSessionEntry;
  marker: NonNullable<InternalSessionEntry["resumeAfterRestart"]>;
  assertCurrent: () => void;
  transcriptOnly?: boolean;
}): Promise<boolean> {
  return recordInterruptedShellNotice({
    ...params,
    text: notice,
    deliver: params.transcriptOnly
      ? undefined
      : async (route, idempotencyKey, check) => {
          const runtime = getGatewayLifecycleRuntime();
          if (!runtime) {
            throw new Error("The original channel notice is awaiting its Gateway delivery owner");
          }
          // The admitted input owns this route. A new session destination cannot receive the notice.
          const { channel, to, accountId, threadId, replyToId } = route;
          const sent = await runtime.sendNotice({
            channel,
            to,
            accountId,
            threadId,
            replyToId,
            text: notice,
            idempotencyKey,
            isCurrent: () => {
              check();
              return true;
            },
          });
          if (sent.suppressed) {
            const { findDeliveryIntentOwner } =
              await import("../infra/outbound/delivery-queue-storage.js");
            if ((await findDeliveryIntentOwner(idempotencyKey))?.status !== "completed") {
              throw new Error(
                "The original channel has not acknowledged the interrupted shell notice",
              );
            }
          }
        },
  });
}
