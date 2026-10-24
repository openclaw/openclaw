import { createMemo, createSignal } from "solid-js";
import { formatDurationCompact, formatDurationHuman } from "../lib/format-duration.ts";
import { i18nRevision } from "../lib/reactive/i18n.ts";
import { useVisiblePoll } from "../lib/reactive/visible-poll.ts";

type ElapsedTimeProps = {
  class?: string;
  startMs?: number | null;
  endMs?: number | null;
  minimumUnit?: "second" | "minute";
  singleUnit?: boolean;
  includeSeconds?: boolean;
};

export function ElapsedTime(props: ElapsedTimeProps) {
  const [tick, setTick] = createSignal(0);
  useVisiblePoll(1_000, () => setTick((value) => value + 1), {
    enabled: () => props.startMs != null && props.endMs == null,
  });
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
          { includeSeconds: props.includeSeconds },
        );
  });
  return (
    <openclaw-elapsed-time class={props.class} style="display: contents">
      {label()}
    </openclaw-elapsed-time>
  );
}
