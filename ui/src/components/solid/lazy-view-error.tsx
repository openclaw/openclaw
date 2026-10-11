import type { JSX as SolidJSX } from "@solidjs/web";
import { Show, createEffect, createSignal, onCleanup } from "solid-js";
import {
  isOptionalElementDefined,
  LazyCustomElementRequestController,
} from "../../app/lazy-custom-element.ts";
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

export function LazyElementModal(props: {
  controller: {
    visibleState: LazyElementState | undefined;
    retry(): void;
    close(): void;
  };
}) {
  const close = () => props.controller.close();
  const [revision, setRevision] = createSignal(0);
  let live = true;
  const modalElement = {
    tagName: "openclaw-modal-dialog",
    get label() {
      return props.controller.visibleState?.element.label ?? t("common.loading");
    },
    loadModule: () => import("../modal-dialog.ts"),
  };
  const loader = new LazyCustomElementRequestController({
    requestUpdate: () => {
      if (live) {
        setRevision((value) => value + 1);
      }
    },
  });
  createEffect(
    () => Boolean(props.controller.visibleState),
    (active) => loader.requestWhileActive(modalElement, active),
  );
  onCleanup(() => {
    live = false;
    loader.requestWhileActive(modalElement, false);
  });
  const loaded = () => {
    revision();
    return isOptionalElementDefined(modalElement);
  };
  const failure = () => {
    revision();
    const state = loader.visibleState;
    return state?.status === "error" ? state : undefined;
  };
  return (
    <Show when={props.controller.visibleState}>
      {(state) => (
        <Show
          when={loaded()}
          fallback={
            <Show
              when={failure()}
              fallback={
                <section class="lazy-element-loading">
                  <LoadingState />
                  <button type="button" class="btn" onClick={close}>
                    {t("common.close")}
                  </button>
                </section>
              }
            >
              {(error) => (
                <LazyViewError
                  error={error().error}
                  stale={error().stale}
                  subtitle={state().element.label}
                  onRetry={() => loader.retry()}
                  onClose={close}
                />
              )}
            </Show>
          }
        >
          <openclaw-modal-dialog
            class={state().status === "loading" ? "lazy-element-loading-modal" : undefined}
            label={state().element.label}
            onModal-cancel={close}
          >
            {state().status === "loading" ? (
              <section class="lazy-element-loading">
                <header class="lazy-element-loading__header">
                  <h2>{state().element.label}</h2>
                  <button
                    class="btn btn--ghost btn--icon"
                    type="button"
                    aria-label={t("common.close")}
                    onClick={close}
                  >
                    <Icon name="x" />
                  </button>
                </header>
                <div
                  class="lazy-element-loading__status"
                  role="status"
                  aria-live="polite"
                  aria-label={t("common.loading")}
                >
                  <span class="btn__spinner" aria-hidden="true" />
                  <span>{t("common.loading")}</span>
                </div>
              </section>
            ) : (
              <LazyElementStateView
                state={state()}
                onRetry={() => props.controller.retry()}
                onClose={close}
              />
            )}
          </openclaw-modal-dialog>
        </Show>
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
