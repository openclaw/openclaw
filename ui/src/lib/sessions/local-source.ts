// Live local sessions: a teammate's native Codex / Claude Code thread projected
// by the Gateway. The device runs every turn; the Gateway only relays input.
import type { SessionLocalInputEvent } from "../../../../packages/gateway-protocol/src/schema/sessions-local.js";
import type { SessionLocalSource } from "../../../../packages/gateway-protocol/src/schema/sessions-row.js";
import type { ChatFollowUpMode } from "../../app/settings.ts";
import { t } from "../../i18n/index.ts";

export type { SessionLocalSource };
export type SessionLocalInputState = SessionLocalInputEvent["state"];

/** Why the composer cannot send right now; null when input is open. */
export function localSourceInputBlockedReason(source: SessionLocalSource): string | null {
  if (!source.connected) {
    return source.reason ?? t("chat.localSession.deviceOffline");
  }
  if (!source.canInput) {
    return source.reason ?? t("chat.localSession.inputUnavailable");
  }
  return null;
}

/** Composer follow-up choices for this source, first entry is the default. */
export function localSourceFollowUpModes(source: SessionLocalSource): ChatFollowUpMode[] {
  const modes: ChatFollowUpMode[] = [];
  for (const mode of source.inputModes) {
    const followUp = mode === "steer" ? "steer" : "queue";
    if (!modes.includes(followUp)) {
      modes.push(followUp);
    }
  }
  return modes;
}

/** Compact "Codex · Scott's MacBook" label; device name wins over the owner label. */
export function localSourceRowLabel(source: SessionLocalSource, deviceName?: string): string {
  return `${source.sourceLabel} · ${deviceName?.trim() || source.ownerLabel}`;
}
