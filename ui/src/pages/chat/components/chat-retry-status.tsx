import { createMemo, createSignal } from "solid-js";
import { t } from "../../../lib/reactive/i18n.ts";
import { createDocumentVisibility } from "../../../lib/reactive/platform.ts";
import { createInterval } from "../../../lib/reactive/timers.ts";

/** Counts down an owner-reported deadline; never guesses timing from provider text. */
export function ChatRetryStatus(props: { retryAt: number | null }) {
  const [tick, setTick] = createSignal(0);
  const visible = createDocumentVisibility();
  const remaining = createMemo(() => {
    // Returning to the document resamples wall time before restarting the countdown.
    visible();
    tick();
    return Math.max(0, Math.ceil(((props.retryAt ?? 0) - Date.now()) / 1_000));
  });
  createInterval(
    () => setTick((value) => value + 1),
    () => (visible() && remaining() > 0 ? 1_000 : undefined),
  );
  return (
    <openclaw-chat-retry-status style={{ display: "contents" }}>
      {remaining() > 0
        ? t("chat.recovery.retryingIn", { seconds: String(remaining()) })
        : t("chat.recovery.retrying")}
    </openclaw-chat-retry-status>
  );
}
