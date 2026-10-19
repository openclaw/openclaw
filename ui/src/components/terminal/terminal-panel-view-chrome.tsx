import { For, Show, createMemo } from "solid-js";
import { t } from "../../lib/reactive/i18n.ts";
import { nativeListener } from "../../lib/solid-native-listener.ts";
import { Icon } from "../solid/icon.tsx";
import { PanelIconButton } from "../solid/panel-icon-button.tsx";
import { PanelLoadingSkeleton } from "../solid/panel-loading-skeleton.tsx";
import { useScrollState } from "../solid/scroll-state.ts";
import { PanelEmptyState } from "../solid/panel-empty-state.tsx";
import "../tooltip.ts";
import "../../styles/session-panel-rail.css";
import type { TerminalPanelViewState } from "./terminal-panel-view-types.ts";

type TerminalSessionPickerState = TerminalPanelViewState["picker"];

/** Header actions stay owned by the panel while its parent hosts their DOM. */
export function TerminalPanelHostedActions(props: {
  view: () => TerminalPanelViewState;
  ref: (element: HTMLSpanElement) => void;
}) {
  return (
    <span ref={props.ref} style={{ display: "contents" }}>
      <Show when={props.view().mobile}>
        <openclaw-tooltip prop:content={t("terminal.dockBottom")}>
          <button
            ref={nativeListener("click", () => props.view().onDock("bottom"))}
            class="rail-header__action"
            type="button"
            aria-label={t("terminal.dockBottom")}
            disabled={props.view().dockDisabled}
          >
            <Icon name="panelBottomOpen" />
          </button>
        </openclaw-tooltip>
      </Show>
    </span>
  );
}

export function SessionMenu(props: {
  state: TerminalSessionPickerState;
  dialogId: string;
  inline?: boolean;
  mobile?: boolean;
  onNew?: () => void;
  dockDisabled?: boolean;
  onDock?: () => void;
}) {
  return (
    <Show when={props.state.open()}>
      <div
        ref={(element) => props.state.menuRef(element)}
        id={props.dialogId}
        class={[
          "tp-session-menu",
          {
            "tp-session-menu--hosted": props.state.hosted,
            "tp-session-menu--inline": props.inline,
          },
        ]}
        onFocusOut={(event) => props.state.onFocusOut(event)}
        role={props.inline ? "region" : "dialog"}
        aria-label={t("terminal.sessions")}
        onKeyDown={(event) => {
          if (event.key === "Escape" && (!props.inline || props.mobile)) {
            event.preventDefault();
            event.stopPropagation();
            props.state.onDismiss(true);
          }
        }}
      >
        <div
          class={[
            "tp-session-menu__header",
            { "session-panel-rail": props.inline && !props.mobile },
          ]}
          data-presentation={props.inline && !props.mobile ? "desktop" : undefined}
        >
          <Show when={props.inline && props.mobile}>
            <PanelIconButton
              label={t("common.back")}
              icon={<Icon name="chevronLeft" />}
              class="tp-rail__icon"
              onClick={() => props.state.onDismiss(true)}
            />
          </Show>
          <span>{t("terminal.sessions")}</span>
          <div class={props.inline && !props.mobile ? "session-panel-rail__group" : undefined}>
            <button
              ref={(element) => props.state.refreshRef(element)}
              disabled={!props.state.connected}
              class={[
                "tp-session-refresh",
                { "session-panel-rail__button": props.inline && !props.mobile },
              ]}
              type="button"
              aria-label={t("terminal.refreshSessions")}
              title={t("terminal.refreshSessions")}
              onClick={() => props.state.onRefresh()}
            >
              <Show when={props.inline || !props.mobile} fallback={t("terminal.refreshSessions")}>
                <Icon name="refresh" />
              </Show>
            </button>
          </div>
          <Show when={props.inline && !props.mobile && props.onDock}>
            <div class="session-panel-rail__group">
              <DockButton
                dock="bottom"
                disabled={props.dockDisabled}
                onClick={() => props.onDock?.()}
                rail
              />
            </div>
          </Show>
        </div>
        <Show
          when={!props.state.loading()}
          fallback={
            <PanelLoadingSkeleton
              variant="terminal"
              compact
              label={t("terminal.loadingSessions")}
            />
          }
        >
          <Show
            when={props.state.sessions().length > 0}
            fallback={
              <Show
                when={props.inline && props.mobile}
                fallback={<div class="tp-session-empty">{t("terminal.noSessions")}</div>}
              >
                <PanelEmptyState
                  heading={t("terminal.noSessions")}
                  description={t("chat.sidePanel.terminalEmpty")}
                  icon={<Icon name="terminal" />}
                  action={
                    <button
                      class="btn"
                      type="button"
                      disabled={!props.state.connected}
                      onClick={() => props.onNew?.()}
                    >
                      <Icon name="plus" />
                      {t("terminal.newSession")}
                    </button>
                  }
                />
              </Show>
            }
          >
            <div class="tp-session-list">
              <Show
                when={props.inline && !props.mobile}
                fallback={
                  <>
                    <Show when={props.mobile}>
                      <div class="tp-session-list__heading">{t("terminal.availableSessions")}</div>
                    </Show>
                    <Show when={props.mobile} fallback={<SessionRows state={props.state} />}>
                      <div class="tp-session-rows">
                        <SessionRows state={props.state} mobile />
                      </div>
                    </Show>
                  </>
                }
              >
                <details class="tp-session-group" open>
                  <summary class="tp-session-list__heading">
                    <span>{t("terminal.availableSessions")}</span>
                    <span class="tp-session-list__count">{props.state.sessions().length}</span>
                    <Icon name="chevronDown" />
                  </summary>
                  <SessionRows state={props.state} />
                </details>
              </Show>
            </div>
          </Show>
        </Show>
      </div>
    </Show>
  );
}

function MobileSessionName(props: { name: string | undefined }) {
  const nameScrollState = useScrollState(true, false);
  return (
    <span class="tp-session__name" ref={nameScrollState} title={props.name}>
      {props.name}
    </span>
  );
}

function SessionRows(props: { state: TerminalSessionPickerState; mobile?: boolean }) {
  return (
    <For each={props.state.sessions()} keyed={(session) => session.sessionId}>
      {(session) => {
        const current = () => props.state.currentSessionIds.has(session().sessionId);
        const label = () =>
          `${session().owner?.startsWith("agent:") ? `${t("terminal.agentOwnedBadge")} · ` : ""}${current() ? t("terminal.currentSession") : session().attached ? t("terminal.sessionAttached") : t("terminal.detached")}`;
        return (
          <button
            class={["tp-session", { "is-current": current() }]}
            disabled={!props.state.connected}
            type="button"
            title={current() ? label() : t("terminal.attachSession")}
            onClick={() => props.state.onAttach(session().sessionId, session().owner)}
          >
            <span class="tp-session__icon">
              <Icon name="terminal" />
            </span>
            <span class="tp-session__identity">
              <Show
                when={props.mobile}
                fallback={
                  <span class="tp-session__name">
                    {session().title ?? session().shell.split(/[\\/]/).pop()}
                  </span>
                }
              >
                <MobileSessionName name={session().title ?? session().shell.split(/[\\/]/).pop()} />
              </Show>
              <span class="tp-session__cwd">
                {session().agentId} · {session().cwd}
              </span>
            </span>
            <span class="tp-session__state">{label()}</span>
            <span class={["tp-session__indicator", { "is-current": current() }]}>
              <Icon name={current() ? "check" : "chevronRight"} />
            </span>
          </button>
        );
      }}
    </For>
  );
}

function DockButton(props: {
  dock: "bottom" | "right";
  disabled?: boolean;
  onClick: () => void;
  rail?: boolean;
}) {
  return (
    <PanelIconButton
      class={props.rail ? "session-panel-rail__button" : "rail-header__action tp-icon"}
      label={props.dock === "bottom" ? t("terminal.dockBottom") : t("terminal.dockRight")}
      icon={<Icon name={props.dock === "bottom" ? "sessionPanelDockBottom" : "sessionPanels"} />}
      disabled={props.disabled}
      onClick={() => props.onClick()}
    />
  );
}

export function Actions(props: { state: TerminalPanelViewState; dialogId: string }) {
  const bottomDesktop = () => !props.state.mobile && props.state.dockLayout.dock === "bottom";
  const destinations = () =>
    [
      {
        dock: "bottom" as const,
        label: t("terminal.dockBottom"),
        icon: "panelBottomOpen" as const,
      },
      { dock: "right" as const, label: t("terminal.dockRight"), icon: "panelRightOpen" as const },
      { dock: "main" as const, label: t("terminal.dockMain"), icon: "columns2" as const },
    ].filter(
      (destination) =>
        destination.dock !== props.state.dockLayout.dock &&
        (!bottomDesktop() || destination.dock === "right"),
    );
  return (
    <div class="rail-header__actions tp-actions">
      <Show when={!props.state.embedded && props.state.upload.uploadsEnabled()}>
        <PanelIconButton
          class="rail-header__action tp-icon tp-upload"
          label={t("terminal.addFiles")}
          icon={<Icon name="paperclip" />}
          disabled={
            !props.state.connected ||
            props.state.upload.hasPendingBatch() ||
            !props.state.upload.hasActiveTab()
          }
          onClick={() => props.state.upload.chooseFiles()}
        />
      </Show>
      <Show when={!props.state.fullscreen}>
        <Show when={!props.state.embedded && !props.state.picker.hidden()}>
          <div class="tp-session-picker">
            <button
              ref={(element) => props.state.picker.triggerRef(element)}
              class={
                props.state.picker.hosted ? "rail-header__action" : "rail-header__action tp-icon"
              }
              type="button"
              title={props.state.picker.hosted ? undefined : t("terminal.sessions")}
              aria-label={t("terminal.sessions")}
              aria-expanded={props.state.picker.open() ? "true" : "false"}
              aria-haspopup="dialog"
              aria-controls={props.state.picker.hosted ? undefined : props.dialogId}
              onClick={() => props.state.picker.onToggle()}
              onFocusOut={(event) => props.state.picker.onFocusOut(event)}
            >
              <Icon name="server" />
            </button>
            <SessionMenu
              state={props.state.picker}
              dialogId={props.dialogId}
              mobile={props.state.mobile}
            />
          </div>
        </Show>
        <Show
          when={!props.state.embedded}
          fallback={
            <Show when={props.state.mobile}>
              <PanelIconButton
                class="rail-header__action tp-icon"
                label={t("terminal.dockBottom")}
                icon={<Icon name="panelBottomOpen" />}
                disabled={props.state.dockDisabled}
                onClick={() => props.state.onDock("bottom")}
              />
            </Show>
          }
        >
          <span class="tp-dock-modes" role="group" aria-label={t("terminal.dockMode")}>
            <For each={destinations()} keyed={(destination) => destination.dock}>
              {(destination) => (
                <openclaw-tooltip prop:content={destination().label}>
                  <Show
                    when={!props.state.mobile && destination().dock !== "main"}
                    fallback={
                      <PanelIconButton
                        class="rail-header__action tp-icon"
                        label={destination().label}
                        icon={<Icon name={destination().icon} />}
                        disabled={props.state.dockDisabled}
                        onClick={() => props.state.onDock(destination().dock)}
                      />
                    }
                  >
                    <DockButton
                      dock={destination().dock === "bottom" ? "bottom" : "right"}
                      disabled={props.state.dockDisabled}
                      onClick={() => props.state.onDock(destination().dock)}
                    />
                  </Show>
                </openclaw-tooltip>
              )}
            </For>
          </span>
          <Show when={!bottomDesktop()}>
            <PanelIconButton
              class="rail-header__action tp-icon tp-open-fullscreen"
              label={t("terminal.openWindow")}
              icon={<Icon name="maximize" />}
              newTab
              onClick={props.state.onOpenFullscreen}
            />
          </Show>
          <PanelIconButton
            class="rail-header__action tp-icon"
            label={t("terminal.hide")}
            icon={<Icon name="x" />}
            onClick={props.state.onHide}
          />
        </Show>
      </Show>
    </div>
  );
}

export function TerminalRail(props: { state: TerminalPanelViewState }) {
  const active = () => props.state.activeTab;
  return (
    <div
      class={["tp-rail", { "session-panel-rail": !props.state.mobile }]}
      data-presentation={props.state.mobile ? undefined : "desktop"}
    >
      <Show
        when={props.state.mobile}
        fallback={
          <>
            <div class="session-panel-rail__group">
              <button
                ref={(element) => props.state.picker.hostedTriggerRef(element)}
                class="session-panel-rail__button"
                type="button"
                title={t("terminal.sessions")}
                aria-label={t("terminal.sessions")}
                onClick={() => props.state.picker.onToggle()}
              >
                <Icon name="chevronLeft" />
              </button>
            </div>
            <div class="tp-rail__identity">
              <strong title={active()?.shellName ?? t("terminal.title")}>
                {active()?.shellName ?? t("terminal.title")}
              </strong>
              <span title={active()?.cwd ?? undefined}>{active()?.cwd}</span>
            </div>
            <Show when={!props.state.fullscreen}>
              <div class="session-panel-rail__group">
                <DockButton
                  dock="bottom"
                  rail
                  disabled={props.state.dockDisabled}
                  onClick={() => props.state.onDock("bottom")}
                />
              </div>
            </Show>
          </>
        }
      >
        <button
          ref={(element) => props.state.picker.hostedTriggerRef(element)}
          class="tp-rail__action"
          type="button"
          aria-label={t("terminal.sessions")}
          onClick={() => props.state.picker.onToggle()}
        >
          <Icon name="server" />
          {t("terminal.sessionsLabel")}
        </button>
        <Show when={props.state.upload.uploadsEnabled()}>
          <button
            class="tp-rail__action tp-upload"
            type="button"
            aria-label={t("terminal.addFiles")}
            disabled={
              !props.state.connected ||
              !props.state.upload.hasActiveTab() ||
              props.state.upload.hasPendingBatch()
            }
            onClick={() => props.state.upload.chooseFiles()}
          >
            <Icon name="paperclip" />
            {t("terminal.addFilesLabel")}
          </button>
        </Show>
      </Show>
    </div>
  );
}
