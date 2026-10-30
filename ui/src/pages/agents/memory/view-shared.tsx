import { parseDateStringTimestampMs } from "@openclaw/normalization-core/number-coercion";
import type { JSX } from "@solidjs/web";
import { Errored, Loading, Show } from "solid-js";
import { formatUiError } from "../../../lib/format-error.ts";
import type { DreamingProps } from "./view-types.ts";

export function DreamingRead(props: {
  read?: DreamingProps["readStatus"];
  on?: unknown;
  fallback?: JSX.Element;
  errorClass?: string;
  children?: JSX.Element;
}) {
  return (
    <Errored
      fallback={(error) =>
        props.errorClass ? <div class={props.errorClass}>{formatUiError(error())}</div> : undefined
      }
    >
      <Loading on={props.on} fallback={props.fallback}>
        {props.read?.() && undefined}
        {props.children}
      </Loading>
    </Errored>
  );
}

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
  busy?: boolean;
  onClick: (event: Event) => void;
}) {
  return (
    <button
      class="btn btn--subtle btn--sm"
      disabled={props.disabled}
      aria-busy={props.busy ? "true" : undefined}
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
