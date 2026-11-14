// Owner notices (spec sections 6 and 8): when the authority reports
// `notify_owners`, the Gateway mails a hint to every owner device through
// Discovery: a pending invite redemption, a resolved one, or a recovery kit used
// to enroll a device. A notice carries only the
// event and a reference (invite id or key fingerprint) and is never authority:
// owner devices confirm at the Gateway directly before acting.
import type { AuthorityEvent } from "../../../packages/openclaw-id-protocol/src/index.js";
import type { DiscoveryClient } from "./discovery-client.js";

type NoticeEvent = Extract<AuthorityEvent, { type: "notify_owners" }>;

type NoticeLogger = { info: (message: string) => void; warn: (message: string) => void };

/**
 * Sends one notice per `notify_owners` event. Best effort: without a Discovery
 * registration (or when Discovery fails) the Gateway logs and carries on.
 */
export async function sendOwnerNotices(params: {
  events: readonly AuthorityEvent[];
  /** The registered claw and a K_gw-signing client, or undefined before registration. */
  target: () => Promise<
    { clawId: string; client: Pick<DiscoveryClient, "sendOwnerNotice"> } | undefined
  >;
  log: NoticeLogger;
}): Promise<void> {
  const notices = params.events.filter(
    (event): event is NoticeEvent => event.type === "notify_owners",
  );
  if (notices.length === 0) {
    return;
  }
  const target = await params.target();
  for (const notice of notices) {
    if (!target) {
      params.log.info(
        `openclaw-id: owner notice ${notice.event} not mailed (not registered with Discovery)`,
      );
      continue;
    }
    try {
      await target.client.sendOwnerNotice(target.clawId, {
        kind: "notice",
        event: notice.event,
        ref: notice.ref,
      });
      params.log.info(`openclaw-id: mailed owner notice ${notice.event}`);
    } catch (error) {
      params.log.warn(
        `openclaw-id: could not mail owner notice ${notice.event}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
