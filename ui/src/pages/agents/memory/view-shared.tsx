import { parseDateStringTimestampMs } from "@openclaw/normalization-core/number-coercion";
import type { JSX } from "@solidjs/web";
import { Errored, Loading, Show } from "solid-js";
import { formatUiError } from "../../../lib/format-error.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import type { DreamingProps } from "./view-types.ts";

export function DreamingRead(props: {
  read?: DreamingProps["readStatus"];
  on?: unknown;
  fallback?: JSX.Element;
  errorClass?: string;
  onRetry?: () => void;
  children?: JSX.Element;
}) {
  return (
    <Errored
      fallback={(error) =>
        props.errorClass ? (
          <Show
            when={props.onRetry}
            fallback={<div class={props.errorClass}>{formatUiError(error())}</div>}
          >
            {(retry) => (
              <div
                class="dreams-diary__error-state"
                style={{
                  display: "flex",
                  "flex-direction": "column",
                  "align-items": "center",
                  "padding-bottom": "var(--space-4)",
                }}
              >
                <div class={props.errorClass}>{formatUiError(error())}</div>
                <button type="button" class="btn btn--sm" onClick={() => retry()()}>
                  {t("common.retry")}
                </button>
              </div>
            )}
          </Show>
        ) : undefined
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
