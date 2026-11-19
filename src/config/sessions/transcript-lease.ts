import type { ChatRef } from "../../sessions/chat-ref.js";
import { isCronRunSessionKey, isCronSessionKey } from "../../sessions/session-key-utils.js";
import { prepareLeaseFacts } from "./session-delivery-generation.js";
import type { TranscriptPin } from "./session-delivery-generation.types.js";

export type TranscriptLease = Awaited<ReturnType<typeof acquireTranscriptLease>>;

const refuseStorage = (): never => {
  throw new Error("A transcript lease cannot be stored; store the chat key.");
};

/**
 * A live writer's hold on one transcript; `lifecycle` holds one scheduled occurrence's
 * incarnation across compaction. The pin stays private and the lease never serialises.
 */
export async function acquireTranscriptLease(
  chat: ChatRef,
  pin: TranscriptPin,
  options: {
    exact?: "lifecycle";
    env?: NodeJS.ProcessEnv;
    onRevoked?: (reason: unknown) => void;
  } = {},
) {
  const { assertCurrent, assertNativeTransactionCurrent, prepareRead, release } =
    await prepareLeaseFacts(
      {
        ...chat,
        env: options.env,
        sessionId: pin.sessionId,
        lifecycleRevision: pin.lifecycleRevision ?? null,
        exact: options.exact ?? "transcript",
      },
      options.onRevoked,
    );
  return {
    assertCurrent,
    assertNativeTransactionCurrent,
    prepareRead,
    release,
    toJSON: refuseStorage,
  };
}

/** Stable cron roots retain their admitted run; exact-run keys already name one transcript. */
export async function acquireCronRootTranscriptLease(
  chat: ChatRef,
  pin: TranscriptPin,
  onRevoked?: (reason: unknown) => void,
) {
  return isCronSessionKey(chat.sessionKey) && !isCronRunSessionKey(chat.sessionKey)
    ? await acquireTranscriptLease(chat, pin, { onRevoked })
    : undefined;
}
