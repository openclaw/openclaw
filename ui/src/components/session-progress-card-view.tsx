import type { ProgressCard, ProgressCardStep, SessionRunStatus } from "@openclaw/gateway-protocol";
import type { JSX } from "@solidjs/web";
import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from "solid-js";
import { t } from "../i18n/index.ts";
import { formatRelativeTimestamp } from "../lib/format.ts";
import { MarkdownDomReconciler } from "../lib/markdown-dom-reconciler.ts";
import { createScrollState } from "./scroll-state.ts";
import {
  progressCardPresentation,
  promoteFirstProgressBar,
  REFRESH_STATUS_LABEL_KEYS,
  sanitizedProgressMarkdown,
  STATUS_LABEL_KEYS,
  TERMINAL_RUN_OUTCOMES,
  type PresentedProgressStepStatus,
  type SessionProgressCardPlacement,
  type SessionProgressCardRefreshAction,
} from "./session-progress-card.ts";
import {
  createComposerDisclosure,
  type ComposerProgressDisclosureContext,
} from "./session-progress-disclosure-controller.ts";
import { Icon } from "./solid/icon.tsx";

export type SessionProgressCardProps = {
  card?: ProgressCard | null;
  placement: SessionProgressCardPlacement;
  onDismiss?: (card: ProgressCard) => void;
  sessionStatus?: SessionRunStatus;
  startedAt?: number;
  endedAt?: number;
  hasActiveRun?: boolean;
  collapseComposerByDefault?: boolean;
  composerDisclosureContext?: ComposerProgressDisclosureContext;
  refreshAction?: SessionProgressCardRefreshAction;
  onClearSaved?: (card: ProgressCard) => void;
  headingMenu?: JSX.Element;
};

export function ProgressCardMarkdown(props: { markdown?: string; promoteProgress?: boolean }) {
  const sanitized = createMemo(() => {
    const html = props.markdown ? sanitizedProgressMarkdown(props.markdown) : "";
    return props.promoteProgress ? promoteFirstProgressBar(html) : html;
  });
  const container = document.createElement("div");
  container.className = "session-progress-card__markdown sidebar-markdown";
  const markdown = new MarkdownDomReconciler(container);
  createEffect(sanitized, (html) => markdown.updateHtml(html));
  onCleanup(() => markdown.dispose());
  return <Show when={props.markdown}>{container}</Show>;
}

function ActivityTime(props: { timestamp: number; labelKey: Parameters<typeof t>[0] }) {
  const [revision, setRevision] = createSignal(0);
  const timer = setInterval(() => setRevision((value) => value + 1), 30_000);
  onCleanup(() => clearInterval(timer));
  const label = () => {
    revision();
    return t(props.labelKey, { time: formatRelativeTimestamp(props.timestamp) });
  };
  return (
    <time datetime={new Date(props.timestamp).toISOString()} aria-label={label()} title={label()}>
      {label()}
    </time>
  );
}

function StepMarker(props: {
  status: PresentedProgressStepStatus;
  sessionStatus?: SessionRunStatus;
}) {
  const outcome = () => props.sessionStatus && TERMINAL_RUN_OUTCOMES[props.sessionStatus];
  return (
    <Show
      when={props.status === "in_progress" && !outcome()}
      fallback={
        <Icon
          name={
            props.status === "completed" ||
            (props.status === "in_progress" && outcome() === "completed")
              ? "check"
              : props.status === "in_progress" && outcome()
                ? "circleX"
                : "clock"
          }
        />
      }
    >
      <span class="session-run-spinner" />
    </Show>
  );
}

function ProgressStep(props: {
  step: ProgressCardStep;
  active: boolean;
  sessionStatus?: SessionRunStatus;
}) {
  const outcome = () =>
    props.step.status === "in_progress" && props.sessionStatus
      ? TERMINAL_RUN_OUTCOMES[props.sessionStatus]
      : undefined;
  const status = (): PresentedProgressStepStatus =>
    props.step.status === "in_progress" && !props.active && !outcome()
      ? "paused"
      : props.step.status;
  const label = () =>
    t(
      outcome()
        ? `sessionProgressCard.status.${outcome()!}`
        : status() === "paused"
          ? "sessionProgressCard.status.paused"
          : STATUS_LABEL_KEYS[props.step.status],
    );
  return (
    <li
      class={["session-progress-card__step", `session-progress-card__step--${status()}`]}
      aria-label={t("sessionProgressCard.stepLabel", { status: label(), step: props.step.step })}
    >
      <span
        class="session-progress-card__step-marker"
        data-status={status()}
        data-outcome={outcome() ? props.sessionStatus : undefined}
        aria-hidden="true"
      >
        <StepMarker status={status()} sessionStatus={props.sessionStatus} />
      </span>
      <span class="session-progress-card__step-text">{props.step.step}</span>
    </li>
  );
}

function ProgressSteps(props: {
  card: ProgressCard;
  active: boolean;
  sessionStatus?: SessionRunStatus;
}) {
  return (
    <Show when={props.card.steps?.length}>
      <ol class="session-progress-card__steps">
        <For each={props.card.steps}>
          {(step) => (
            <ProgressStep step={step} active={props.active} sessionStatus={props.sessionStatus} />
          )}
        </For>
      </ol>
    </Show>
  );
}

function CardAction(props: {
  card: ProgressCard;
  action: "dismiss" | "clear-saved";
  onAction?: (card: ProgressCard) => void;
}) {
  const label = () =>
    t(
      props.action === "dismiss" ? "sessionProgressCard.dismiss" : "sessionProgressCard.clearSaved",
    );
  return (
    <Show when={props.onAction}>
      <button
        class={`rail-header__action session-progress-card__${props.action}`}
        type="button"
        aria-label={label()}
        title={label()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          props.onAction?.(props.card);
        }}
      >
        <Icon name={props.action === "dismiss" ? "x" : "trash"} />
      </button>
    </Show>
  );
}

function Refresh(props: { card: ProgressCard; action?: SessionProgressCardRefreshAction }) {
  const pending = () => props.action?.state === "pending";
  const retry = () => props.action?.state === "failed" || props.action?.state === "timeout";
  const label = () =>
    t(
      pending()
        ? "sessionProgressCard.refresh.pending"
        : retry()
          ? "sessionProgressCard.refresh.retry"
          : "sessionProgressCard.refresh.label",
    );
  return (
    <Show when={props.action}>
      <button
        class="session-progress-card__refresh"
        type="button"
        data-state={props.action?.state ?? "idle"}
        aria-label={label()}
        title={
          retry() && props.action?.state
            ? t(REFRESH_STATUS_LABEL_KEYS[props.action.state])
            : label()
        }
        aria-busy={pending() ? "true" : "false"}
        disabled={pending()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!pending()) {
            props.action?.onRefresh(props.card);
          }
        }}
      >
        <Icon
          name={pending() ? "loader" : props.action?.state === "updated" ? "check" : "refresh"}
        />
      </button>
    </Show>
  );
}

function CardContent(props: SessionProgressCardProps & { card: ProgressCard }) {
  const presentation = createMemo(() =>
    progressCardPresentation(
      props.card,
      props.sessionStatus,
      props.startedAt,
      props.endedAt,
      props.hasActiveRun ?? true,
    ),
  );
  const time = () => (
    <ActivityTime
      timestamp={presentation().activityTimestamp}
      labelKey={presentation().activityKey}
    />
  );
  const steps = () => (
    <ProgressSteps
      card={props.card}
      active={presentation().hasCurrentRunActivity}
      sessionStatus={presentation().effectiveSessionStatus}
    />
  );
  const Composer = () => {
    const disclosure = createComposerDisclosure(() => [
      props.composerDisclosureContext?.sessionIdentity ?? props.card.sessionKey,
      !props.collapseComposerByDefault,
      props.composerDisclosureContext,
    ]);
    const scroll = createScrollState(() => props.card);
    return (
      <details
        ref={disclosure}
        class={[
          "session-progress-card session-progress-card--composer",
          { "session-progress-card--details": props.placement === "details" },
        ]}
        data-progress-card-placement={props.placement}
        data-complete={String(presentation().complete)}
      >
        <summary
          class="session-progress-card__summary"
          aria-label={`${presentation().stepLabel}. ${presentation().outcomeLabel ?? presentation().countLabel}`}
        >
          <span
            class={[
              "session-progress-card__summary-indicator session-progress-card__current-marker",
              {
                "session-progress-card__summary-indicator--complete":
                  presentation().complete || presentation().effectiveSessionStatus === "done",
              },
            ]}
            data-status={presentation().presentedCurrentStatus ?? "pending"}
            data-outcome={presentation().effectiveSessionStatus}
            aria-hidden="true"
          >
            <StepMarker
              status={
                presentation().terminalOutcome
                  ? "in_progress"
                  : presentation().complete
                    ? "completed"
                    : presentation().currentStep?.status === "in_progress"
                      ? (presentation().presentedCurrentStatus ?? "pending")
                      : "pending"
              }
              sessionStatus={presentation().effectiveSessionStatus}
            />
          </span>
          <span class="session-progress-card__summary-collapsed">
            <span class="session-progress-card__current">{presentation().stepLabel}</span>
          </span>
          <Show when={presentation().counts}>
            <span
              class="session-progress-card__summary-count session-progress-card__summary-count--collapsed"
              data-outcome={presentation().effectiveSessionStatus}
            >
              {presentation().outcomeLabel ??
                `${presentation().currentPosition}/${presentation().counts!.total}`}
            </span>
          </Show>
          <span class="session-progress-card__summary-expanded">
            <span class="session-progress-card__summary-title">
              {t("sessionProgressCard.composerTitle")}
            </span>
            <span class="session-progress-card__heading-actions">
              <span>
                {time()}
                {presentation().counts
                  ? ` · ${t("sessionProgressCard.shortCount", {
                      completed: String(presentation().currentPosition),
                      total: String(presentation().counts!.total),
                    })}`
                  : undefined}
              </span>
            </span>
          </span>
          <span class="session-progress-card__summary-controls">
            <Refresh card={props.card} action={props.refreshAction} />
            {props.headingMenu}
            <CardAction card={props.card} action="clear-saved" onAction={props.onClearSaved} />
            <CardAction card={props.card} action="dismiss" onAction={props.onDismiss} />
            <span
              class="session-progress-card__summary-chevron session-progress-card__chevron"
              aria-hidden="true"
            >
              <Icon name="chevronDown" />
            </span>
          </span>
          <Show when={props.refreshAction?.state}>
            <span
              class="session-progress-card__refresh-status"
              data-state={props.refreshAction?.state}
              role="status"
            >
              {t(REFRESH_STATUS_LABEL_KEYS[props.refreshAction!.state!])}
            </span>
          </Show>
        </summary>
        <div
          class="session-progress-card__body"
          role="region"
          aria-label={presentation().countLabel}
          ref={scroll}
        >
          <ProgressCardMarkdown markdown={props.card.markdown} />
          {steps()}
        </div>
      </details>
    );
  };
  return (
    <Show
      when={props.placement === "composer" || props.placement === "details"}
      fallback={
        <section
          class={`session-progress-card session-progress-card--${props.placement}`}
          data-progress-card-placement={props.placement}
          aria-label={presentation().countLabel}
        >
          <div class="session-progress-card__heading">
            <span>{t("sessionProgressCard.title")}</span>
            <span class="session-progress-card__heading-actions">
              <span>
                {time()}
                {presentation().counts
                  ? ` · ${presentation().counts!.completed}/${presentation().counts!.total}`
                  : undefined}
              </span>
              <CardAction card={props.card} action="dismiss" onAction={props.onDismiss} />
            </span>
          </div>
          <div class="session-progress-card__body">
            <ProgressCardMarkdown markdown={props.card.markdown} />
            {steps()}
          </div>
        </section>
      }
    >
      <Composer />
    </Show>
  );
}

export function SessionProgressCard(props: SessionProgressCardProps) {
  return (
    <Show when={props.card}>
      {(card) => {
        // Teardown may read after the parent clears the card; keep this branch's admitted value.
        const initialCard = untrack(card);
        return <CardContent {...props} card={props.card ?? initialCard} />;
      }}
    </Show>
  );
}
