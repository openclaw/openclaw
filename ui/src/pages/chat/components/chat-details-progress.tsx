import { createEffect, createMemo, createUniqueId, Show } from "solid-js";
import {
  ProgressDetailsContent,
  ProgressDetailsRefresh,
  ProgressDetailsRefreshStatus,
  SessionProgressCard,
  type ProgressDetailsContentProps,
} from "../../../components/session-progress-card-solid.tsx";
import {
  progressCardPresentation,
  type SessionProgressCardRefreshAction,
} from "../../../components/session-progress-card.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { Menu, type MenuEntry, type MenuHandle } from "../../../components/solid/menu.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import type { ChatDetailsProps } from "./chat-details-types.ts";

type Props = {
  props?: ChatDetailsProps;
  presented: boolean;
  desktop?: boolean;
  menuRef?: (menu: MenuHandle) => void;
  onHideProgress?: () => void;
};

/** The pane owns the durable card, lifetime and all actions. */
export function ChatDetailsProgress(props: Props) {
  return (
    <openclaw-chat-details-progress>
      <Show
        when={props.props?.progressCard}
        fallback={
          props.props?.progressCardInitialLoading && (
            <div class="chat-details__muted" role="status">
              {t("sessionProgressCard.widgetLoading")}
            </div>
          )
        }
      >
        <SessionProgressCard
          card={props.props?.progressCard}
          placement="details"
          desktopDetails={props.desktop}
          onDismiss={props.props?.onDismissProgressCard}
          onClearSaved={props.props?.onClearSavedProgressCard}
          sessionStatus={props.props?.selectedSession?.status}
          startedAt={props.props?.selectedSession?.startedAt}
          endedAt={props.props?.selectedSession?.endedAt}
          hasActiveRun={props.props?.runActive}
          collapseComposerByDefault={props.props?.collapseTaskProgress}
          composerDisclosureContext={{
            presented: props.presented,
            gatewayScope: props.props?.gatewayScope,
            sessionIdentity: props.props?.progressCardIdentity,
            cardLifetime: props.props?.progressCardLifetime,
            manualOnly: true,
          }}
          refreshAction={props.props?.progressCardRefresh}
          menuRef={props.menuRef}
          menuOptions={{
            class: "chat-details-progress__menu",
            disabled: !props.presented,
            items: [
              {
                id: "hide",
                label: t("chat.sessionDetails.hideProgress"),
                icon: props.desktop ? <Icon name="eyeOff" /> : undefined,
              },
              {
                id: "collapse",
                label: t("chat.sessionDetails.collapseDefault"),
                type: "checkbox",
                checked: props.props?.collapseTaskProgress === true,
                icon: props.desktop ? <Icon name="foldVertical" /> : undefined,
              },
              {
                id: "settings",
                label: t("chat.sessionDetails.settings"),
                icon: props.desktop ? <Icon name="settings" /> : undefined,
              },
            ],
            onSelect: (item) => {
              switch (item.id) {
                case "hide":
                  props.onHideProgress?.();
                  props.props?.onHideTaskProgress?.();
                  break;
                case "collapse":
                  props.props?.onCollapseTaskProgressChange?.(!props.props?.collapseTaskProgress);
                  break;
                case "settings":
                  props.props?.onOpenTaskProgressSettings?.();
                  break;
              }
            },
          }}
        />
      </Show>
    </openclaw-chat-details-progress>
  );
}

export type MobileTaskProgressProps = Omit<ProgressDetailsContentProps, "card"> & {
  card: ProgressDetailsContentProps["card"] | null | undefined;
  initialLoading: boolean;
  error?: "access-denied" | "unavailable";
  presented: boolean;
  refreshAction?: SessionProgressCardRefreshAction;
  showTaskProgress: boolean;
  onShowTaskProgressChange: (shown: boolean) => void;
  onClearSavedProgressCard?: (card: ProgressDetailsContentProps["card"]) => void;
};

/** The mobile Details host supplies the title, scroll surface and Back ancestry. */
export function MobileTaskProgressContent(props: MobileTaskProgressProps) {
  return (
    <div class="task-progress-details task-progress-details--mobile">
      <Show
        when={props.card}
        fallback={
          <Show
            when={props.initialLoading || props.error || props.card === undefined}
            fallback={
              <div class="task-progress-details__empty">
                <Icon name="listChecks" />
                <strong>{t("sessionProgressCard.detailsEmptyTitle")}</strong>
                <p>{t("sessionProgressCard.detailsEmptyDescription")}</p>
              </div>
            }
          >
            <div class="chat-details__muted" role="status">
              {t(
                props.error === "access-denied"
                  ? "sessionProgressCard.widgetAccessDenied"
                  : props.error
                    ? "sessionProgressCard.widgetUnavailable"
                    : "sessionProgressCard.widgetLoading",
              )}
            </div>
          </Show>
        }
      >
        {(card) => (
          <>
            <ProgressDetailsRefreshStatus
              card={card()}
              action={props.refreshAction}
              disabled={!props.presented}
            />
            <ProgressDetailsContent {...props} card={card()} />
          </>
        )}
      </Show>
    </div>
  );
}

/** The mobile Details host mounts this footer outside its scroll mask. */
export function MobileTaskProgressControls(props: MobileTaskProgressProps) {
  const id = createUniqueId();
  let menu: MenuHandle | undefined;
  createEffect(
    () => props.presented,
    (presented) => {
      if (!presented) {
        menu?.close();
      }
    },
  );
  const view = createMemo(() =>
    props.card
      ? progressCardPresentation(
          props.card,
          props.sessionStatus,
          props.startedAt,
          props.endedAt,
          props.hasActiveRun ?? true,
        )
      : undefined,
  );
  const items = createMemo<MenuEntry[]>(() => [
    {
      id: "show-in-chat",
      label: t("sessionProgressCard.showInChat"),
      type: "checkbox",
      checked: props.showTaskProgress,
      render: (attributes) => (
        <button
          {...attributes}
          type="button"
          class="oc-menu-item task-progress-details__show-in-chat"
        >
          <span class="oc-menu-item__label">{t("sessionProgressCard.showInChat")}</span>
          <span
            class="task-progress-details__switch"
            data-checked={props.showTaskProgress ? "true" : "false"}
            aria-hidden="true"
            inert
          />
        </button>
      ),
    },
    ...(props.onClearSavedProgressCard && props.card
      ? [
          {
            kind: "group" as const,
            id: "clear-group",
            class: "task-progress-details__clear-group",
            items: [
              {
                id: "clear",
                label: t("sessionProgressCard.clearSaved"),
                variant: "danger" as const,
                icon: <Icon name="trash" />,
              },
            ],
          },
        ]
      : []),
  ]);
  return (
    <div class="task-progress-details__mobile-controls">
      <Show when={view()?.counts}>
        <output
          class="task-progress-details__position"
          aria-label={t("sessionProgressCard.stepCount", {
            current: String(view()?.currentPosition),
            total: String(view()?.counts?.total),
          })}
        >
          {view()?.currentPosition} / {view()?.counts?.total}
        </output>
      </Show>
      <div class="task-progress-details__mobile-actions">
        <Show when={props.card}>
          {(card) => (
            <ProgressDetailsRefresh
              hideTooltip
              card={card()}
              action={props.refreshAction}
              disabled={!props.presented}
            />
          )}
        </Show>
        <Menu
          id={id}
          lazy="while-open"
          label={t("chat.sessionDetails.progressOptions")}
          placement="top-end"
          trigger={<Icon name="moreHorizontal" />}
          triggerClass="task-progress-details__mobile-options"
          panelClass="task-progress-details__mobile-menu"
          disabled={!props.presented}
          ref={(value) => {
            menu = value;
          }}
          items={items()}
          onSelect={(item) => {
            if (!props.presented) {
              return;
            }
            if (item.id === "show-in-chat") {
              props.onShowTaskProgressChange(!props.showTaskProgress);
            } else if (item.id === "clear" && props.card) {
              props.onClearSavedProgressCard?.(props.card);
            }
          }}
        />
      </div>
    </div>
  );
}
