import { t } from "../reactive/i18n.ts";
import type { ChatGoalRecovery } from "./chat-types.ts";

/** Presentation follows the saved operation; retired requests no longer retain its action. */
export function goalRecoveryPresentation(recovery: ChatGoalRecovery) {
  const kind = recovery.retired ? "retired" : (recovery.action ?? "unknown");
  return {
    title: t(`chat.goals.recovery.${kind}.${recovery.pending ? "pending" : "title"}`),
    action: t(`chat.goals.recovery.${kind}.action`),
    description: recovery.retired
      ? t(
          recovery.retired === "expired"
            ? "chat.goals.recoveryExpired"
            : "chat.goals.recoveryInvalid",
        )
      : recovery.pending
        ? ""
        : t(`chat.goals.recovery.${kind}.description`),
  };
}
