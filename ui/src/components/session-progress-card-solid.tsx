import type { ProgressCard, SessionRunStatus } from "@openclaw/gateway-protocol";
import { createEffect, createMemo, createUniqueId, onCleanup, Show } from "solid-js";
import { i18nRevision, t } from "../lib/reactive/i18n.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";
import { CardActivity, StepMarker, Steps } from "./session-progress-card-content.tsx";
import { ProgressCardMarkdown } from "./session-progress-card-view.tsx";
import {
  progressCardPresentation,
  REFRESH_STATUS_LABEL_KEYS,
  type SessionProgressCardRefreshAction,
} from "./session-progress-card.ts";
import {
  createComposerProgressDisclosure,
  type ComposerProgressDisclosureContext,
} from "./session-progress-disclosure-binding.ts";
import { Icon } from "./solid/icon.tsx";
import { Menu, type MenuEntry, type MenuHandle, type MenuProps } from "./solid/menu.tsx";
import { useScrollState } from "./solid/scroll-state.ts";
import { Tooltip } from "./solid/tooltip.tsx";
import "../styles/chat/task-progress-details.css";

export type SessionProgressCardProps = {
  card: ProgressCard | null | undefined;
  placement: "board" | "composer" | "details";
  /** Explicit native desktop Details presentation; legacy/mobile callers retain their behavior. */
  desktopDetails?: boolean;
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
  // Resolve presentation props before Menu reads open during lifecycle setup.
  const disabled = createMemo(() => props.menuOptions?.disabled);
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
      details:
        props.placement === "details" ? (
          <CardActivity
            view={() => progressCardPresentation(props.card)}
            hideCount
            hideTooltip={props.desktopDetails}
          />
        ) : undefined,
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
    () => {
      const actions: MenuEntry[] = [
        ...(props.refreshAction ? [refreshItem()] : []),
        ...(props.onDismiss
          ? [
              {
                id: "dismiss",
                label: t("sessionProgressCard.hide"),
                icon: props.desktopDetails ? <Icon name="x" /> : undefined,
              },
            ]
          : []),
      ];
      const clear: MenuEntry[] = props.onClearSaved
        ? [
            {
              id: "clear",
              label: t("sessionProgressCard.clearSaved"),
              icon: props.desktopDetails ? <Icon name="trash" /> : undefined,
              variant: props.desktopDetails ? "danger" : undefined,
            },
          ]
        : [];
      const preferences = props.menuOptions?.items ?? [];
      if (!props.desktopDetails) {
        return [...actions, ...clear, ...preferences];
      }
      return [
        {
          kind: "group",
          id: "card-actions",
          class: "task-progress-details__menu-group",
          items: actions,
        },
        {
          kind: "group",
          id: "preferences",
          class: "task-progress-details__menu-group",
          items: preferences,
        },
        {
          kind: "group",
          id: "shared-progress",
          class: "task-progress-details__menu-group",
          items: clear,
        },
      ];
    },
    { lazy: true },
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
                props.placement === "details"
                  ? "moreHorizontal"
                  : pending()
                    ? "loader"
                    : props.refreshAction?.state === "updated"
                      ? "check"
                      : "moreHorizontal"
              }
            />
          }
          triggerAttributes={{
            "data-state":
              props.placement === "details" ? undefined : (props.refreshAction?.state ?? "idle"),
            "aria-busy": props.placement === "details" ? undefined : pending() ? "true" : "false",
          }}
          items={items()}
          disabled={disabled()}
          open={disabled() ? false : undefined}
          ref={(value) => props.menuRef?.(value)}
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

function cardPresentation(props: ProgressDetailsContentProps) {
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

export type ProgressDetailsContentProps = Pick<
  CardProps,
  "card" | "sessionStatus" | "startedAt" | "endedAt" | "hasActiveRun"
>;

/** The same saved plan and native step states, without composer or board chrome. */
export function ProgressDetailsContent(props: ProgressDetailsContentProps) {
  const view = cardPresentation(props);
  return (
    <div class="task-progress-details__plan" data-has-steps={Boolean(props.card.steps?.length)}>
      <ProgressCardMarkdown markdown={props.card.markdown} />
      <Steps
        card={props.card}
        hasActiveRun={view().hasCurrentRunActivity}
        sessionStatus={view().effectiveSessionStatus}
      />
    </div>
  );
}

export function ProgressDetailsRefresh(props: {
  card: ProgressCard;
  action?: SessionProgressCardRefreshAction;
  disabled?: boolean;
  desktopDetails?: boolean;
  hideTooltip?: boolean;
}) {
  const pending = () => props.action?.state === "pending";
  return (
    <Show when={props.action}>
      <Tooltip placement="top" disabled={props.disabled || props.hideTooltip}>
        <button
          type="button"
          class="task-progress-details__refresh"
          aria-label={t(
            pending() ? "sessionProgressCard.refresh.pending" : "sessionProgressCard.refresh.label",
          )}
          aria-busy={pending() ? "true" : "false"}
          disabled={props.disabled || pending()}
          data-pending={pending() ? "true" : "false"}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!props.disabled && !pending()) {
              props.action?.onRefresh(props.card);
            }
          }}
        >
          <Icon name={pending() ? "loader" : "refresh"} />
        </button>
        <span slot="content" class="task-progress-details__refresh-tooltip">
          <span>{t("sessionProgressCard.refresh.label")}</span>
          <CardActivity
            view={() => progressCardPresentation(props.card)}
            hideCount
            hideTooltip={props.desktopDetails}
          />
        </span>
      </Tooltip>
    </Show>
  );
}

export function ProgressDetailsRefreshStatus(props: {
  card: ProgressCard;
  action?: SessionProgressCardRefreshAction;
  disabled?: boolean;
}) {
  const failed = () => props.action?.state === "failed" || props.action?.state === "timeout";
  return (
    <Show when={props.action?.state}>
      {(state) => (
        <div class="task-progress-details__refresh-status" data-state={state()} role="status">
          <span>{t(REFRESH_STATUS_LABEL_KEYS[state()])}</span>
          <Show when={failed()}>
            <button
              type="button"
              class="task-progress-details__retry"
              disabled={props.disabled}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (!props.disabled) {
                  props.action?.onRefresh(props.card);
                }
              }}
            >
              {t("common.retry")}
            </button>
          </Show>
        </div>
      )}
    </Show>
  );
}

function DetailsCard(props: CardProps) {
  const view = cardPresentation(props);
  const noteSummary = createMemo(() => {
    if (!props.desktopDetails || view().counts || !props.card.markdown) {
      return "";
    }
    // Reuse the full note's parser; the collapsed text preview omits progress bars.
    const template = document.createElement("template");
    template.innerHTML = toSanitizedMarkdownHtml(props.card.markdown, {
      progressBars: true,
      codeBlockChrome: "none",
    });
    for (const bar of template.content.querySelectorAll("progress")) {
      bar.remove();
    }
    return template.content.textContent?.replace(/\s+/gu, " ").trim() ?? "";
  });
  const currentOverflow = useScrollState(true, false);
  const disclosure = createComposerProgressDisclosure(() => [
    props.composerDisclosureContext?.sessionIdentity ?? props.card.sessionKey,
    !props.collapseComposerByDefault,
    props.composerDisclosureContext,
  ]);
  let element: HTMLDetailsElement;
  let body: HTMLDivElement;
  let animation: Animation | undefined;
  const finishMotion = () => {
    if (!animation) {
      return;
    }
    animation.cancel();
    animation = undefined;
    element.removeAttribute("data-details-moving");
    body.inert = false;
  };
  const toggle = (event: MouseEvent) => {
    if (!props.desktopDetails) {
      disclosure.onClick(event);
      return;
    }
    const from = element.getBoundingClientRect().height;
    const wasOpen = element.open;
    disclosure.onClick(event);
    if (element.open === wasOpen) {
      return;
    }
    // The native disclosure still owns the choice. Only its painted height is animated.
    // Sample before cancelling so a second click reverses from the visible position.
    finishMotion();
    if (event.detail === 0) {
      return;
    }
    const to = element.getBoundingClientRect().height;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduced) {
      element.setAttribute("data-details-moving", "");
      body.inert = !element.open;
    }
    animation = element.animate(
      reduced
        ? [{ opacity: 0.7 }, { opacity: 1 }]
        : [{ height: `${from}px` }, { height: `${to}px` }],
      { duration: reduced ? 100 : 300, easing: "cubic-bezier(0.4, 0, 0.2, 1)" },
    );
    animation.onfinish = finishMotion;
  };
  createEffect(
    () => props.composerDisclosureContext?.presented,
    (presented) => {
      if (presented === false) {
        finishMotion();
      }
    },
  );
  onCleanup(finishMotion);
  return (
    <details
      ref={(value) => {
        element = value;
        disclosure.details(value);
      }}
      onClick={toggle}
      class="task-progress-details task-progress-details--desktop"
      data-progress-card-placement="details"
      data-desktop-details={props.desktopDetails ? "" : undefined}
    >
      <summary ref={disclosure.summary} class="task-progress-details__summary">
        <span class="task-progress-details__heading">
          <span class="task-progress-details__title">{t("sessionProgressCard.composerTitle")}</span>
          <span class="task-progress-details__chevron" aria-hidden="true">
            <Icon name="chevronDown" />
          </span>
          <Show when={!props.desktopDetails || view().counts}>
            <span
              class="task-progress-details__current-marker session-progress-card__current-marker"
              aria-hidden="true"
            >
              <Show when={view().counts} fallback={<Icon name="listChecks" />}>
                <StepMarker
                  status={
                    view().complete ? "completed" : (view().presentedCurrentStatus ?? "pending")
                  }
                  outcome={view().terminalOutcome}
                />
              </Show>
            </span>
          </Show>
          <span
            ref={currentOverflow}
            class="task-progress-details__current"
            data-note={props.desktopDetails && !view().counts ? "" : undefined}
          >
            {view().counts
              ? view().stepLabel
              : props.desktopDetails
                ? noteSummary()
                : t("sessionProgressCard.composerTitle")}
          </span>
          <Show when={!props.desktopDetails && view().counts}>
            <span
              class="task-progress-details__count"
              aria-label={t("sessionProgressCard.stepCount", {
                current: String(view().currentPosition),
                total: String(view().counts?.total),
              })}
            >
              {view().currentPosition}/{view().counts?.total}
            </span>
          </Show>
        </span>
        <span class="task-progress-details__actions">
          <span class="task-progress-details__expanded-refresh">
            <ProgressDetailsRefresh
              card={props.card}
              action={props.refreshAction}
              disabled={props.menuOptions?.disabled}
              desktopDetails={props.desktopDetails}
            />
          </span>
          <CardMenu {...props} />
        </span>
        <ProgressDetailsRefreshStatus
          card={props.card}
          action={props.refreshAction}
          disabled={props.menuOptions?.disabled}
        />
      </summary>
      <div
        ref={(value) => {
          body = value;
          disclosure.body(value);
        }}
        class="task-progress-details__body"
      >
        <ProgressDetailsContent {...props} />
      </div>
    </details>
  );
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
        onWheel={disclosure.onWheel}
        onPointerDown={disclosure.onPointerDown}
        onPointerMove={disclosure.onPointerMove}
        onPointerUp={disclosure.onPointerEnd}
        onPointerCancel={disclosure.onPointerEnd}
        onLostPointerCapture={disclosure.onPointerEnd}
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
          <Show
            when={props.placement === "details"}
            fallback={<ComposerCard {...props} card={card()} />}
          >
            <DetailsCard {...props} card={card()} />
          </Show>
        </Show>
      )}
    </Show>
  );
}
