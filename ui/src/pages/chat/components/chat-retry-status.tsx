import { createMemo } from "solid-js";
import { t } from "../../../lib/reactive/i18n.ts";
import { readVisibleTime } from "../../../lib/reactive/visible-clock.ts";

/** Counts down an owner-reported deadline; never guesses timing from provider text. */
export function ChatRetryStatus(props: { retryAt: number | null }) {
  const remaining = createMemo(() => {
    const now = Date.now();
    const deadline = props.retryAt ?? 0;
    if (deadline > now) {
      readVisibleTime(1_000);
    }
    return Math.max(0, Math.ceil((deadline - now) / 1_000));
  });
  return (
    <openclaw-chat-retry-status style={{ display: "contents" }}>
      {remaining() > 0
        ? t("chat.recovery.retryingIn", { seconds: String(remaining()) })
        : t("chat.recovery.retrying")}
    </openclaw-chat-retry-status>
  );
}
