import { Show } from "solid-js";
import { formatDateTimeMs, formatRelativeTimestamp } from "../lib/reactive/format.ts";

// Recent activity reads as "2h ago"; older dates stay absolute and drop the seconds.
const RELATIVE_DATE_MS = 7 * 24 * 60 * 60 * 1000;

export function DateLabel(props: { value: string | undefined }) {
  return (
    <Show when={props.value}>
      {(value) => {
        const time = () => new Date(value()).getTime();
        return (
          <time
            datetime={value()}
            title={Number.isNaN(time()) ? value() : formatDateTimeMs(time())}
          >
            {Number.isNaN(time())
              ? value()
              : Date.now() - time() < RELATIVE_DATE_MS
                ? formatRelativeTimestamp(time())
                : formatDateTimeMs(time(), { dateStyle: "medium" })}
          </time>
        );
      }}
    </Show>
  );
}
