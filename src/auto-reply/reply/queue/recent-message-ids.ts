import type { SessionControllerMailbox } from "../../../sessions/session-controller.mailbox.js";
import type { FollowupRun } from "./types.js";
const TTL = 5 * 60 * 1000;
const MAX = 10_000;
export function peekRecentQueueMessageId(
  key: string,
  mailbox: SessionControllerMailbox | undefined,
  now = Date.now(),
): boolean {
  const record = mailbox?.recentSources.get(key);
  if (!record) {
    return false;
  }
  if (record.expires > now) {
    return true;
  }
  mailbox?.recentSources.delete(key);
  return false;
}
export function recordRecentQueueMessageId(run: FollowupRun, key: string, now = Date.now()): void {
  const input = run.controllerInput;
  if (!input) {
    throw new Error("Dedupe source was not submitted to its mailbox");
  }
  const mailbox = input.mailbox;
  for (const [alias, record] of mailbox.recentSources) {
    if (record.expires <= now) {
      mailbox.recentSources.delete(alias);
    }
  }
  if (mailbox.recentSources.size >= MAX) {
    mailbox.recentSources.delete(mailbox.recentSources.keys().next().value!);
  }
  mailbox.recentSources.set(key, { input, expires: now + TTL });
  const lifecycle = run.turnAdoptionLifecycle;
  if (lifecycle) {
    const onAbandoned = lifecycle.onAbandoned;
    lifecycle.onAbandoned = () => {
      if (mailbox.recentSources.get(key)?.input === input) {
        mailbox.recentSources.delete(key);
      }
      return onAbandoned?.();
    };
  }
}
