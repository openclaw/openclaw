import { createMemo } from "solid-js";
import { formatDurationCompact, formatDurationHuman } from "../lib/format-duration.ts";
import { i18nRevision } from "../lib/reactive/i18n.ts";
import { readVisibleTime } from "../lib/reactive/visible-clock.ts";

export function ElapsedTime(props: {
  class?: string;
  startMs?: number | null;
  endMs?: number | null;
  minimumUnit?: "second" | "minute";
  singleUnit?: boolean;
  includeSeconds?: boolean;
}) {
  const label = createMemo(() => {
    i18nRevision();
    if (props.startMs == null) {
      return undefined;
    }
    const minimumMs = props.minimumUnit === "minute" ? 60_000 : 1_000;
    const elapsedMs = Math.max(minimumMs, (props.endMs ?? readVisibleTime(1_000)) - props.startMs);
    return props.singleUnit
      ? formatDurationHuman(elapsedMs)
      : formatDurationCompact(
          props.minimumUnit === "minute" ? Math.floor(elapsedMs / 60_000) * 60_000 : elapsedMs,
          { includeSeconds: props.includeSeconds },
        );
  });
  return (
    <openclaw-elapsed-time class={props.class} style="display: contents">
      {label()}
    </openclaw-elapsed-time>
  );
}
