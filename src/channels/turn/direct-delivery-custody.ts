import {
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
  type ReplyPayload,
} from "../../auto-reply/reply-payload.js";
import {
  assertSessionWriterDeliveryAuthorized,
  prepareSessionWriterDeliveryAuthority,
} from "../../auto-reply/reply/session-writer-delivery-authority.js";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import { settlePendingFinalDelivery } from "../../infra/outbound/delivery-completion.js";
import type { ChannelDeliveryInfo } from "./types.js";

type DirectPendingFinalCustody = Pick<ChannelDeliveryInfo, "bindPendingFinalDelivery"> & {
  assertPlatformSendAuthorized: () => void;
  onPlatformSendDispatch: () => Promise<void>;
  release: () => void;
};

export const NO_PENDING_FINAL_CUSTODY: DirectPendingFinalCustody = {
  assertPlatformSendAuthorized: () => undefined,
  onPlatformSendDispatch: () => Promise.resolve(),
  release: () => undefined,
};

export function resolvePendingFinalCompletion(payload: ReplyPayload) {
  const identity = getReplyPayloadMetadata(payload)?.pendingFinalDeliveryCompletion;
  return identity ? { kind: "pending-final" as const, ...identity } : undefined;
}

export async function createDirectPendingFinalCustody(
  payload: ReplyPayload,
  fallbackStorePath?: string,
): Promise<DirectPendingFinalCustody | undefined> {
  const completion = resolvePendingFinalCompletion(payload);
  const originalAuthority = getReplyPayloadMetadata(payload)?.sessionWriterDeliveryAuthority;
  if (!completion && !originalAuthority) {
    return undefined;
  }
  const { authority, release } = await prepareSessionWriterDeliveryAuthority(
    originalAuthority,
    fallbackStorePath,
  );
  const identity = completion ? (({ kind: _kind, ...value }) => value)(completion) : undefined;
  let admission: Promise<void> | undefined;
  return {
    bindPendingFinalDelivery: (nextPayload) =>
      setReplyPayloadMetadata(nextPayload, {
        ...(identity ? { pendingFinalDeliveryCompletion: identity } : {}),
        ...(authority ? { sessionWriterDeliveryAuthority: authority } : {}),
      }),
    assertPlatformSendAuthorized: () => assertSessionWriterDeliveryAuthorized(authority),
    release,
    onPlatformSendDispatch: async () => {
      // One logical delivery retains custody across all of its physical posts.
      await (admission ??= (async () => {
        if (!completion) {
          return;
        }
        const result = await settlePendingFinalDelivery(completion, "unknown", [
          "prepared",
          "queued",
        ]);
        if (result.state !== "unknown") {
          throw new PlatformMessageNotDispatchedError(
            "Pending final delivery ownership changed before platform dispatch",
            { cause: new Error(`pending final delivery is ${result.state}`) },
          );
        }
      })());
      assertSessionWriterDeliveryAuthorized(authority);
    },
  };
}

export function toCoreManagedDeliveryInfo(info: ChannelDeliveryInfo) {
  return {
    kind: info.kind,
    ...(info.participant ? { participant: info.participant } : {}),
    ...(info.assistantMessageIndex === undefined
      ? {}
      : { assistantMessageIndex: info.assistantMessageIndex }),
  };
}
