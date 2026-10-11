import { For, Show } from "solid-js";
import "../../styles/capacity-meter.css";

type CapacityMeterProps = {
  label: string;
  tone: "ok" | "stale" | "warn" | "danger" | "accent";
} & (
  | { mode: "continuous"; percent: number }
  | { mode: "discrete"; total: number; used: number | null }
);

export function CapacityMeter(props: CapacityMeterProps) {
  const pips = () => props.mode === "discrete" && props.total <= 12;
  const percent = () =>
    props.mode === "continuous"
      ? props.percent
      : props.used === null
        ? 0
        : (props.used / props.total) * 100;
  return (
    <Show
      when={pips()}
      fallback={
        <span
          class={`session-context-meter session-context-meter--${props.tone}`}
          role="img"
          aria-label={props.label}
        >
          <span class="session-context-meter__fill" style={{ width: `${percent()}%` }} />
        </span>
      }
    >
      <span
        class={`capacity-meter-pips session-context-meter--${props.tone}`}
        role="img"
        aria-label={props.label}
      >
        <For
          each={Array.from(
            { length: props.mode === "discrete" ? props.total : 0 },
            (_, index) => index,
          )}
        >
          {(index) => (
            <span
              class={[
                "capacity-meter-pips__pip",
                {
                  "capacity-meter-pips__pip--filled":
                    props.mode === "discrete" && props.used !== null && index < props.used,
                },
              ]}
            />
          )}
        </For>
      </span>
    </Show>
  );
}
