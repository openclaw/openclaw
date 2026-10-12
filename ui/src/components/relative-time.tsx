import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { createMemo, createSignal, Show } from "solid-js";
import { formatDateTimeMs, formatRelativeTimestamp } from "../lib/format.ts";
import { i18nRevision } from "../lib/reactive/i18n.ts";
import { useVisiblePoll } from "../lib/reactive/visible-poll.ts";
import { defineSolidBridge } from "../lit/solid-bridge.ts";

defineSolidBridge<{ timestampMs: number | null }>(
  "openclaw-relative-time",
  (props) => {
    const [tick, setTick] = createSignal(0);
    useVisiblePoll(60_000, () => setTick((value) => value + 1)).start();
    const time = createMemo(() => {
      tick();
      i18nRevision();
      const timestamp = asDateTimestampMs(props.timestampMs);
      return timestamp === undefined
        ? undefined
        : {
            datetime: new Date(timestamp).toISOString(),
            title: formatDateTimeMs(timestamp),
            label: formatRelativeTimestamp(timestamp),
          };
    });
    return (
      <Show when={time()}>
        {(current) => (
          <time datetime={current().datetime} title={current().title}>
            {current().label}
          </time>
        )}
      </Show>
    );
  },
  { properties: { timestampMs: { default: null, attribute: false } } },
);
