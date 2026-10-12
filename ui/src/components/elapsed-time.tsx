import { createEffect, createMemo, createSignal } from "solid-js";
import { formatDurationCompact, formatDurationHuman } from "../lib/format-duration.ts";
import { i18nRevision } from "../lib/reactive/i18n.ts";
import { useVisiblePoll } from "../lib/reactive/visible-poll.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lit/solid-bridge.ts";

type ElapsedTimeProps = {
  startMs: number | null;
  endMs: number | null;
  minimumUnit: "second" | "minute";
  singleUnit: boolean;
};

defineSolidBridge<ElapsedTimeProps>(
  "openclaw-elapsed-time",
  (props) => {
    const [tick, setTick] = createSignal(0);
    const polling = useVisiblePoll(1_000, () => setTick((value) => value + 1));
    createEffect(
      () => props.startMs != null && props.endMs == null,
      (ticking) => {
        if (ticking) {
          polling.start();
        } else {
          polling.stop();
        }
      },
    );
    const label = createMemo(() => {
      tick();
      i18nRevision();
      if (props.startMs == null) {
        return undefined;
      }
      const minimumMs = props.minimumUnit === "minute" ? 60_000 : 1_000;
      const elapsedMs = Math.max(minimumMs, (props.endMs ?? Date.now()) - props.startMs);
      return props.singleUnit
        ? formatDurationHuman(elapsedMs)
        : formatDurationCompact(
            props.minimumUnit === "minute" ? Math.floor(elapsedMs / 60_000) * 60_000 : elapsedMs,
          );
    });
    return <>{label()}</>;
  },
  {
    properties: {
      startMs: { default: null, type: Number },
      endMs: { default: null, type: Number },
      minimumUnit: { default: "second" },
      singleUnit: { default: false },
    },
    connected: (host) => (host.style.display = "contents"),
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-elapsed-time": SolidBridgeElement<ElapsedTimeProps>;
  }
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-elapsed-time": HTMLAttributes<HTMLElementTagNameMap["openclaw-elapsed-time"]> &
        Properties<HTMLElementTagNameMap["openclaw-elapsed-time"]>;
    }
  }
}
