import { parseDateStringTimestampMs } from "@openclaw/normalization-core/number-coercion";
import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";

export function formatCompactDateTime(value: string): string {
  const parsed = parseDateStringTimestampMs(value);
  if (parsed === undefined) {
    return value;
  }
  return new Date(parsed).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function DreamingAction(props: {
  label: string;
  disabled: boolean;
  onClick: (event: Event) => void;
}) {
  return (
    <button
      class="btn btn--subtle btn--sm"
      disabled={props.disabled}
      onClick={(event) => props.onClick(event)}
    >
      {props.label}
    </button>
  );
}

export function DiaryEmpty(props: { message: string; hint?: string; children?: JSX.Element }) {
  return (
    <div class="dreams-diary__empty">
      {props.children}
      <div class="dreams-diary__empty-text">{props.message}</div>
      <Show when={props.hint}>
        {(hint) => <div class="dreams-diary__empty-hint">{hint()}</div>}
      </Show>
    </div>
  );
}
