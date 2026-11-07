// A root statement refused for a stale seq (OCF-313). Kit enrollment signs its
// MembershipChange at Discovery's snapshot seq + 1, so `seq_conflict` from the
// mailbox means the mirror is behind the authority: the Gateway republishes at
// once and tells the sending device, which can sign again at the current seq.
// The notice is a hint, never authority; the device re-reads the republished,
// K_gw-signed snapshot before signing again.
import {
  isKeyFingerprint,
  type MailboxMessage,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import type { AuthorityRefusal } from "./authority.js";
import type { DiscoveryClient } from "./discovery-client.js";

type StaleSeqLogger = { info: (message: string) => void; warn: (message: string) => void };

/** True for a mailbox root statement refused because its seq is not the next one. */
export function isStaleSeqRefusal(message: MailboxMessage, refusal: AuthorityRefusal): boolean {
  return message.payload.kind === "root_statement" && refusal.code === "seq_conflict";
}

/**
 * Handles a stale-seq refusal: republishes (`republish` marks the publication
 * pending and runs it), then mails a `seq_conflict` notice with the current seq
 * to the sending device when Discovery reported its key fingerprint. Both steps
 * are best effort; the republish alone lets the device's next attempt succeed.
 */
export async function handleStaleSeqRefusal(params: {
  message: MailboxMessage;
  currentSeq: number;
  republish: () => Promise<void>;
  target: () => Promise<
    { clawId: string; client: Pick<DiscoveryClient, "sendDeviceNotice"> } | undefined
  >;
  log: StaleSeqLogger;
}): Promise<void> {
  params.log.info(
    `openclaw-id: root statement refused for a stale seq (current ${params.currentSeq}); republishing`,
  );
  await params.republish();
  const deviceFp = params.message.from.device_fp;
  if (!isKeyFingerprint(deviceFp)) {
    return;
  }
  const target = await params.target();
  if (!target) {
    return;
  }
  try {
    await target.client.sendDeviceNotice(target.clawId, deviceFp, {
      kind: "notice",
      event: "seq_conflict",
      ref: String(params.currentSeq),
    });
    params.log.info(`openclaw-id: told ${deviceFp} its statement used a stale seq`);
  } catch (error) {
    params.log.warn(
      `openclaw-id: could not mail the seq_conflict notice: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
