import { createMemo, createSignal } from "solid-js";
import { t } from "../../../lib/reactive/i18n.ts";
import { createDocumentVisibility } from "../../../lib/reactive/platform.ts";
import { createInterval } from "../../../lib/reactive/timers.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lib/solid-bridge.ts";

type ChatRetryStatusProps = { retryAt: number | null };

/** Counts down an owner-reported deadline; never guesses timing from provider text. */
defineSolidBridge<ChatRetryStatusProps>(
  "openclaw-chat-retry-status",
  (props) => {
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
      <>
        {remaining() > 0
          ? t("chat.recovery.retryingIn", { seconds: String(remaining()) })
          : t("chat.recovery.retrying")}
      </>
    );
  },
  {
    properties: { retryAt: { default: null, type: Number } },
    connected: (host) => (host.style.display = "contents"),
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-retry-status": SolidBridgeElement<ChatRetryStatusProps>;
  }
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-chat-retry-status": HTMLAttributes<
        HTMLElementTagNameMap["openclaw-chat-retry-status"]
      > &
        Properties<HTMLElementTagNameMap["openclaw-chat-retry-status"]>;
    }
  }
}
