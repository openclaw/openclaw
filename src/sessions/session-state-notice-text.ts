import { parseAgentSessionKey } from "./session-key-utils.js";

// Terse on purpose: this line lands in model prompts, possibly repeatedly across
// turns. Text must stay byte-stable per frozen watermark so queue dedupe holds,
// and the reconciliation call must be self-contained (explicit target sessionKey).
export function sessionStateNoticeText(targetSessionKey: string, lastSeenSequence: number): string {
  return `Session "${targetSessionKey}" changed (other actor). Reconcile before acting: session_status sessionKey "${targetSessionKey}" changesSince ${lastSeenSequence}. Reconcile silently and continue any authorized work. If there is no useful user-facing outcome or blocker, reply exactly NO_REPLY. Do not repeat this notice.`;
}

/** Released notices have no dedicated source or display marker; recognize only complete producer lines. */
export function isLegacySessionStateNoticeText(text: string): boolean {
  return text
    .trim()
    .split("\n")
    .every((line) => {
      const match =
        /^Session "(agent:[^"\r\n]+)" changed \(other actor\)\. Reconcile before acting: session_status sessionKey "\1" changesSince \d+\.$/u.exec(
          line,
        );
      return match !== null && parseAgentSessionKey(match[1]) !== null;
    });
}
