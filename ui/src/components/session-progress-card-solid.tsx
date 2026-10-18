import type { ProgressCard, ProgressCardStep, SessionRunStatus } from "@openclaw/gateway-protocol";
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  Show,
  useContext,
} from "solid-js";
import { formatRelativeTimestamp } from "../lib/format.ts";
import { i18nRevision, t } from "../lib/reactive/i18n.ts";
import { ContentPresentation } from "../lib/solid/presentation.ts";
import { ProgressCardMarkdown } from "./session-progress-card-view.tsx";
import {
  progressCardPresentation,
  REFRESH_STATUS_LABEL_KEYS,
  STATUS_LABEL_KEYS,
  TERMINAL_RUN_OUTCOMES,
  type PresentedProgressStepStatus,
  type SessionProgressCardRefreshAction,
} from "./session-progress-card.ts";
import {
  createComposerProgressDisclosure,
  type ComposerProgressDisclosureContext,
} from "./session-progress-disclosure-binding.ts";
import { Icon } from "./solid/icon.tsx";
import { Menu, type MenuEntry, type MenuHandle, type MenuProps } from "./solid/menu.tsx";
import { useScrollState } from "./solid/scroll-state.ts";

export type SessionProgressCardProps = {
  card: ProgressCard | null | undefined;
  placement: "board" | "composer" | "details";
  onDismiss?: (card: ProgressCard) => void;
  sessionStatus?: SessionRunStatus;
  startedAt?: number;
  endedAt?: number;
  hasActiveRun?: boolean;
  collapseComposerByDefault?: boolean;
  composerDisclosureContext?: ComposerProgressDisclosureContext;
  refreshAction?: SessionProgressCardRefreshAction;
  onClearSaved?: (card: ProgressCard) => void;
  menuOptions?: Pick<MenuProps, "items" | "onSelect" | "disabled" | "class">;
  menuRef?: (menu: MenuHandle) => void;
};

type CardProps = SessionProgressCardProps & { card: ProgressCard };

function CardActivity(props: { view: ReturnType<typeof cardPresentation>; composer?: boolean }) {
  const presented = useContext(ContentPresentation);
  const [revision, setRevision] = createSignal(0);
  createEffect(createMemo(presented), (active): void | (() => void) => {
    if (active) {
      setRevision((value) => value + 1);
      const timer = setInterval(() => setRevision((value) => value + 1), 30_000);
      return () => clearInterval(timer);
    }
  });
  const timestamp = () => props.view().activityTimestamp;
  const label = createMemo(() => {
    revision();
    return t(props.view().activityKey, { time: formatRelativeTimestamp(timestamp()) });
  });
  const count = createMemo(() => {
    const { counts, currentPosition } = props.view();
    return counts
      ? props.composer
        ? `${t("sessionProgressCard.stepCount", {
            current: String(currentPosition),
            total: String(counts.total),
          })} · `
        : ` · ${counts.completed}/${counts.total}`
      : "";
  });
  return (
    <span>
      {props.composer && count()}
      <time datetime={new Date(timestamp()).toISOString()} aria-label={label()} title={label()}>
        {label()}
      </time>
      {!props.composer && count()}
    </span>
  );
}

function StepMarker(props: {
  status: PresentedProgressStepStatus;
  outcome?: ReturnType<typeof progressCardPresentation>["terminalOutcome"];
}) {
  return (
    <Show
      when={props.status === "in_progress" && !props.outcome}
      fallback={
        <Icon
          name={
            (props.outcome ?? props.status) === "completed"
              ? "check"
              : props.outcome
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

function Steps(props: {
  card: ProgressCard;
  hasActiveRun: boolean;
  sessionStatus?: SessionRunStatus;
}) {
  return (
    <Show when={props.card.steps?.length}>
      <ol class="session-progress-card__steps">
        <For each={props.card.steps}>
          {(step) => (
            <Step
              step={step}
              hasActiveRun={props.hasActiveRun}
              sessionStatus={props.sessionStatus}
            />
          )}
        </For>
      </ol>
    </Show>
  );
}

function Step(props: {
  step: ProgressCardStep;
  hasActiveRun: boolean;
  sessionStatus?: SessionRunStatus;
}) {
  const terminalOutcome = () =>
    props.step.status === "in_progress" && props.sessionStatus
      ? TERMINAL_RUN_OUTCOMES[props.sessionStatus]
      : undefined;
  const status = (): PresentedProgressStepStatus =>
    props.step.status === "in_progress" && !props.hasActiveRun && !terminalOutcome()
      ? "paused"
      : props.step.status;
  const label = () =>
    t(
      terminalOutcome()
        ? `sessionProgressCard.status.${terminalOutcome()}`
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
        data-outcome={terminalOutcome() ? props.sessionStatus : undefined}
        aria-hidden="true"
      >
        <StepMarker status={status()} outcome={terminalOutcome()} />
      </span>
      <span class="session-progress-card__step-text">{props.step.step}</span>
    </li>
  );
}

function CardAction(props: { card: ProgressCard; onAction?: (card: ProgressCard) => void }) {
  const label = () => t("sessionProgressCard.dismiss");
  return (
    <Show when={props.onAction}>
      <button
        class="rail-header__action session-progress-card__dismiss"
        type="button"
        aria-label={label()}
        title={label()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          props.onAction?.(props.card);
        }}
      >
        <Icon name="x" />
      </button>
    </Show>
  );
}

function CardMenu(props: CardProps) {
  const id = createUniqueId();
  let menu: MenuHandle | undefined;
  const pending = () => props.refreshAction?.state === "pending";
  const retry = () =>
    props.refreshAction?.state === "failed" || props.refreshAction?.state === "timeout";
  const label = () =>
    t(
      pending()
        ? "sessionProgressCard.refresh.pending"
        : retry()
          ? "sessionProgressCard.refresh.retry"
          : "sessionProgressCard.refresh.label",
    );
  const refreshItem = createMemo<MenuEntry>(
    () => ({
      id: "refresh",
      get label() {
        return label();
      },
      get disabled() {
        return pending();
      },
      class: "session-progress-card__refresh",
      icon: (
        <Icon
          name={
            pending() ? "loader" : props.refreshAction?.state === "updated" ? "check" : "refresh"
          }
        />
      ),
      get attributes() {
        return {
          "data-state": props.refreshAction?.state ?? "idle",
          "aria-busy": pending() ? ("true" as const) : ("false" as const),
        };
      },
    }),
    { lazy: true },
  );
  const items = createMemo<MenuEntry[]>(
    () => [
      ...(props.refreshAction ? [refreshItem()] : []),
      ...(props.onDismiss ? [{ id: "dismiss", label: t("sessionProgressCard.hide") }] : []),
      ...(props.onClearSaved ? [{ id: "clear", label: t("sessionProgressCard.clearSaved") }] : []),
      ...(props.menuOptions?.items ?? []),
    ],
    { lazy: true },
  );
  createEffect(
    () => props.menuOptions?.disabled,
    (disabled) => {
      if (disabled) {
        menu?.close();
      }
    },
  );
  return (
    <Show
      when={
        props.refreshAction ||
        props.onDismiss ||
        props.onClearSaved ||
        props.menuOptions?.items.length
      }
    >
      <div
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <Menu
          lazy="while-open"
          id={id}
          class={props.menuOptions?.class}
          triggerClass="session-progress-card__options"
          label={t("chat.sessionDetails.progressOptions")}
          placement="bottom-end"
          trigger={
            <Icon
              name={
                pending()
                  ? "loader"
                  : props.refreshAction?.state === "updated"
                    ? "check"
                    : "moreHorizontal"
              }
            />
          }
          triggerAttributes={{
            "data-state": props.refreshAction?.state ?? "idle",
            "aria-busy": pending() ? "true" : "false",
          }}
          items={items()}
          disabled={props.menuOptions?.disabled}
          ref={(value) => {
            menu = value;
            props.menuRef?.(value);
          }}
          onSelect={(item, event) => {
            if (props.menuOptions?.disabled) {
              return;
            }
            switch (item.id) {
              case "refresh":
                if (!pending()) {
                  props.refreshAction?.onRefresh(props.card);
                }
                break;
              case "dismiss":
                props.onDismiss?.(props.card);
                break;
              case "clear":
                props.onClearSaved?.(props.card);
                break;
              default:
                props.menuOptions?.onSelect?.(item, event);
            }
          }}
        />
      </div>
    </Show>
  );
}

function cardPresentation(props: CardProps) {
  return createMemo(() => {
    i18nRevision();
    return progressCardPresentation(
      props.card,
      props.sessionStatus,
      props.startedAt,
      props.endedAt,
      props.hasActiveRun ?? true,
    );
  });
}

function ComposerCard(props: CardProps) {
  const view = cardPresentation(props);
  const disclosure = createComposerProgressDisclosure(() => [
    props.composerDisclosureContext?.sessionIdentity ?? props.card.sessionKey,
    !props.collapseComposerByDefault,
    props.composerDisclosureContext,
  ]);
  const bodyScroll = useScrollState();
  return (
    <details
      ref={disclosure.details}
      onClick={disclosure.onClick}
      class={[
        "session-progress-card session-progress-card--composer",
        { "session-progress-card--details": props.placement === "details" },
      ]}
      data-progress-card-placement={props.placement}
      data-complete={String(view().complete)}
    >
      <summary
        ref={disclosure.summary}
        class="session-progress-card__summary"
        aria-label={`${view().stepLabel}. ${view().outcomeLabel ?? view().countLabel}`}
      >
        <span
          class={[
            "session-progress-card__summary-indicator session-progress-card__current-marker",
            {
              "session-progress-card__summary-indicator--complete":
                view().complete || view().effectiveSessionStatus === "done",
            },
          ]}
          data-status={view().presentedCurrentStatus ?? "pending"}
          data-outcome={view().effectiveSessionStatus}
          aria-hidden="true"
        >
          <StepMarker
            status={view().complete ? "completed" : (view().presentedCurrentStatus ?? "pending")}
            outcome={view().terminalOutcome}
          />
        </span>
        <span class="session-progress-card__summary-collapsed">
          <span class="session-progress-card__current">{view().stepLabel}</span>
        </span>
        <Show when={view().counts}>
          <span
            class="session-progress-card__summary-count session-progress-card__summary-count--collapsed"
            data-outcome={view().effectiveSessionStatus}
          >
            {view().outcomeLabel ?? `${view().currentPosition}/${view().counts?.total}`}
          </span>
        </Show>
        <span class="session-progress-card__summary-expanded">
          <span class="session-progress-card__summary-title">
            {t("sessionProgressCard.composerTitle")}
          </span>
          <span class="session-progress-card__heading-actions">
            <CardActivity view={view} composer />
          </span>
        </span>
        <span class="session-progress-card__summary-controls">
          <CardMenu {...props} />
          <span
            class="session-progress-card__summary-chevron session-progress-card__chevron"
            aria-hidden="true"
          >
            <Icon name="chevronDown" />
          </span>
        </span>
        <Show when={props.refreshAction?.state}>
          {(state) => (
            <span class="session-progress-card__refresh-status" data-state={state()} role="status">
              {t(REFRESH_STATUS_LABEL_KEYS[state()])}
            </span>
          )}
        </Show>
      </summary>
      <div
        ref={[bodyScroll, disclosure.body]}
        class="session-progress-card__body"
        role="region"
        aria-label={view().countLabel}
      >
        <ProgressCardMarkdown markdown={props.card.markdown} />
        <Steps
          card={props.card}
          hasActiveRun={view().hasCurrentRunActivity}
          sessionStatus={view().effectiveSessionStatus}
        />
      </div>
    </details>
  );
}

function BoardCard(props: CardProps) {
  const view = cardPresentation(props);
  return (
    <section
      class={["session-progress-card", `session-progress-card--${props.placement}`]}
      data-progress-card-placement={props.placement}
      aria-label={view().countLabel}
    >
      <div class="session-progress-card__heading">
        <span>{t("sessionProgressCard.title")}</span>
        <span class="session-progress-card__heading-actions">
          <CardActivity view={view} />
          <CardAction card={props.card} onAction={props.onDismiss} />
        </span>
      </div>
      <div class="session-progress-card__body">
        <ProgressCardMarkdown markdown={props.card.markdown} />
        <Steps
          card={props.card}
          hasActiveRun={view().hasCurrentRunActivity}
          sessionStatus={view().effectiveSessionStatus}
        />
      </div>
    </section>
  );
}

export function SessionProgressCard(props: SessionProgressCardProps) {
  return (
    <Show when={props.card}>
      {(card) => (
        <Show when={props.placement !== "board"} fallback={<BoardCard {...props} card={card()} />}>
          <ComposerCard {...props} card={card()} />
        </Show>
      )}
    </Show>
  );
}
