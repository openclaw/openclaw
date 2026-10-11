import type { JSX as SolidJSX } from "@solidjs/web";
import { Show } from "solid-js";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { Icon } from "./icon.tsx";
import { LoadingState } from "./loading-state.tsx";

export function AgentStartupState() {
  return (
    <section class="agent-startup-state" role="status" aria-live="polite">
      <span class="btn__spinner" aria-hidden="true" />
      <div>{t("agentStartup.title")}</div>
      <div>{t("agentStartup.description")}</div>
    </section>
  );
}

export type LazyElementState =
  | { status: "loading"; element: { label: string } }
  | { status: "error"; element: { label: string }; error: unknown; stale: boolean };

export function LazyElementStateView(props: {
  state: LazyElementState;
  onRetry: () => void;
  onClose: () => void;
}) {
  const error = () => (props.state.status === "error" ? props.state : undefined);
  return (
    <Show when={error()} fallback={<LoadingState />}>
      {(state) => (
        <LazyViewError
          actionLabel={t("common.retry")}
          error={state().error}
          stale={state().stale}
          subtitle={state().element.label}
          onRetry={props.onRetry}
          onClose={props.onClose}
        />
      )}
    </Show>
  );
}

export function LazyViewError(props: {
  actionLabel?: string;
  error: unknown;
  onClose?: (event: Event) => void;
  onRetry: (event: Event) => void;
  render?: () => SolidJSX.Element;
  stale?: boolean;
  subtitle?: string;
}) {
  return (
    <>
      {props.render?.()}
      <PanelErrorState
        title={props.stale ? t("lazyView.staleTitle") : t("lazyView.errorTitle")}
        subtitle={
          props.subtitle ??
          (props.stale ? t("lazyView.staleSubtitle") : t("lazyView.genericSubtitle"))
        }
        actions={
          <>
            <button class="btn lazy-view-error__action" onClick={(event) => props.onRetry(event)}>
              {props.actionLabel ?? (props.stale ? t("common.reload") : t("lazyView.retry"))}
            </button>
            {props.onClose ? (
              <button class="btn" type="button" onClick={(event) => props.onClose?.(event)}>
                {t("common.close")}
              </button>
            ) : undefined}
          </>
        }
        detail={formatUiError(props.error)}
        inline={Boolean(props.render)}
        stale={props.stale}
      />
    </>
  );
}

export function PanelErrorState(props: {
  actions?: SolidJSX.Element;
  className?: string;
  detail?: string;
  inline?: boolean;
  role?: "alert" | "status";
  stale?: boolean;
  subtitle: string;
  title: string;
}) {
  return (
    <div
      class={[
        "lazy-view-error",
        props.className,
        { "lazy-view-error--inline": props.inline, "lazy-view-error--stale": props.stale },
      ]}
      role={props.role ?? "alert"}
    >
      <div class="lazy-view-error__icon" aria-hidden="true">
        <Icon name={props.stale ? "refresh" : "alertTriangle"} />
      </div>
      <div class="lazy-view-error__title">{props.title}</div>
      <div class="lazy-view-error__subtitle">{props.subtitle}</div>
      {props.actions ? <div class="lazy-view-error__actions">{props.actions}</div> : undefined}
      {props.detail ? (
        <details class="lazy-view-error__details">
          <summary>{t("chat.details")}</summary>
          <code class="lazy-view-error__detail">{props.detail}</code>
        </details>
      ) : undefined}
    </div>
  );
}
