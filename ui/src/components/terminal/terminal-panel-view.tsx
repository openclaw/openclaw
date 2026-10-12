import { For, Show, createMemo, untrack } from "solid-js";
import "@awesome.me/webawesome/dist/components/tab-panel/tab-panel.js";
import { t } from "../../lib/reactive/i18n.ts";
import { generateUUID } from "../../lib/uuid.ts";
import type { DockLayoutController } from "../dock-layout-controller.ts";
import { DockResizer } from "../dock-layout-solid.tsx";
import { PanelTabStrip } from "../panel-tab-strip-solid.tsx";
import { Icon } from "../solid/icon.tsx";
import type { PanelEmptyStateElement, PanelEmptyStateProps } from "../solid/panel-empty-state.tsx";
import "../solid/panel-empty-state.tsx";
import { PanelLoadingSkeleton } from "../solid/panel-loading-skeleton.tsx";
import "../tooltip.ts";
import type { TerminalSessionInfo } from "./terminal-connection.ts";
import { terminalPanelHostedTabs, type TerminalPanelTab } from "./terminal-panel-tabs.ts";
import type { TerminalPanelUploadController } from "./terminal-panel-upload.ts";

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-panel-empty-state": HTMLAttributes<PanelEmptyStateElement> & {
        "prop:heading": PanelEmptyStateProps["heading"];
        "prop:description": PanelEmptyStateProps["description"];
      };
    }
  }
}

type TerminalSessionPickerState = {
  hosted: boolean;
  open: boolean;
  loading: boolean;
  sessions: TerminalSessionInfo[];
  currentSessionIds: ReadonlySet<string>;
  triggerRef: (element: HTMLButtonElement) => void;
  onToggle: () => void;
  onDismiss: (restoreFocus: boolean) => void;
  onFocusOut: (event: FocusEvent) => void;
  onRefresh: () => void;
  onAttach: (sessionId: string, owner: TerminalSessionInfo["owner"]) => void;
};

export type TerminalPanelViewState = {
  open: boolean;
  embedded: boolean;
  fullscreen: boolean;
  hosted: boolean;
  mode: string;
  style: string | undefined;
  dockLayout: DockLayoutController<"bottom" | "right" | "main">;
  tabs: TerminalPanelTab[];
  activeId: string | null;
  booting: boolean;
  connecting: boolean;
  error: { text: string; retry?: () => void } | null;
  dockDisabled: boolean;
  picker: TerminalSessionPickerState;
  upload: TerminalPanelUploadController;
  onSelect: (id: string) => void;
  onClose: (id: string) => Promise<void>;
  onNew: () => void;
  onDock: (dock: "bottom" | "right" | "main") => void;
  onOpenFullscreen: () => void;
  onHide: () => void;
};

function SessionPickerTrigger(props: { state: TerminalSessionPickerState; dialogId: string }) {
  return (
    <button
      ref={(element) => untrack(() => props.state.triggerRef(element))}
      class={props.state.hosted ? "rail-header__action" : "rail-header__action tp-icon"}
      type="button"
      title={props.state.hosted ? undefined : t("terminal.sessions")}
      aria-label={t("terminal.sessions")}
      aria-expanded={props.state.open ? "true" : "false"}
      aria-haspopup="dialog"
      aria-controls={props.state.hosted ? undefined : props.dialogId}
      onClick={() => props.state.onToggle()}
      onFocusOut={(event) => props.state.onFocusOut(event)}
    >
      <Icon name="server" />
    </button>
  );
}

function Loading(props: { compact?: boolean; overlay?: boolean; label: string }) {
  return (
    <PanelLoadingSkeleton
      variant="terminal"
      label={props.label}
      compact={Boolean(props.compact)}
      overlay={Boolean(props.overlay)}
    />
  );
}

function SessionMenu(props: { state: TerminalSessionPickerState; dialogId: string }) {
  return (
    <Show when={props.state.open}>
      <div
        id={props.dialogId}
        class={["tp-session-menu", { "tp-session-menu--hosted": props.state.hosted }]}
        onFocusOut={(event) => props.state.onFocusOut(event)}
        role="dialog"
        aria-label={t("terminal.sessions")}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            props.state.onDismiss(true);
          }
        }}
      >
        <div class="tp-session-menu__header">
          <span>{t("terminal.sessions")}</span>
          <button class="tp-session-refresh" type="button" onClick={() => props.state.onRefresh()}>
            {t("terminal.refreshSessions")}
          </button>
        </div>
        <Show
          when={!props.state.loading}
          fallback={<Loading compact label={t("terminal.loadingSessions")} />}
        >
          <Show
            when={props.state.sessions.length > 0}
            fallback={<div class="tp-session-empty">{t("terminal.noSessions")}</div>}
          >
            <For each={props.state.sessions} keyed={(session) => session.sessionId}>
              {(session) => {
                const current = createMemo(() =>
                  props.state.currentSessionIds.has(session().sessionId),
                );
                const label = createMemo(
                  () =>
                    `${session().owner?.startsWith("agent:") ? `${t("terminal.agentOwnedBadge")} · ` : ""}${current() ? t("terminal.currentSession") : session().attached ? t("terminal.sessionAttached") : t("terminal.detached")}`,
                );
                return (
                  <button
                    class="tp-session"
                    type="button"
                    disabled={current()}
                    title={current() ? label() : t("terminal.attachSession")}
                    onClick={() => props.state.onAttach(session().sessionId, session().owner)}
                  >
                    <span class="tp-session__agent">{session().agentId}</span>
                    <span class="tp-session__cwd">{session().cwd}</span>
                    <span class="tp-session__state">{label()}</span>
                  </button>
                );
              }}
            </For>
          </Show>
        </Show>
      </div>
    </Show>
  );
}

function ActionButton(props: {
  label: string;
  icon: Parameters<typeof Icon>[0]["name"];
  class?: string;
  disabled?: boolean;
  newTab?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      class={props.class ?? "rail-header__action tp-icon"}
      type="button"
      title={props.label}
      aria-label={props.label}
      disabled={props.disabled}
      data-new-tab-action={props.newTab ? "" : undefined}
      onClick={() => props.onClick()}
    >
      <Icon name={props.icon} />
    </button>
  );
}

function Actions(props: { state: TerminalPanelViewState; dialogId: string }) {
  const destinations = () =>
    [
      {
        dock: "bottom" as const,
        label: t("terminal.dockBottom"),
        icon: "panelBottomOpen" as const,
      },
      { dock: "right" as const, label: t("terminal.dockRight"), icon: "panelRightOpen" as const },
      { dock: "main" as const, label: t("terminal.dockMain"), icon: "columns2" as const },
    ].filter((destination) => destination.dock !== props.state.dockLayout.dock);
  return (
    <div class="rail-header__actions tp-actions">
      <Show when={props.state.upload.uploadsEnabled()}>
        <ActionButton
          class="rail-header__action tp-icon tp-upload"
          label={t("terminal.addFiles")}
          icon="paperclip"
          disabled={props.state.upload.hasPendingBatch() || !props.state.upload.hasActiveTab()}
          onClick={props.state.upload.chooseFiles}
        />
      </Show>
      <Show when={!props.state.fullscreen}>
        <div class="tp-session-picker">
          <SessionPickerTrigger state={props.state.picker} dialogId={props.dialogId} />
          <SessionMenu state={props.state.picker} dialogId={props.dialogId} />
        </div>
        <Show
          when={!props.state.embedded}
          fallback={
            <ActionButton
              label={t("terminal.dockBottom")}
              icon="panelBottomOpen"
              disabled={props.state.dockDisabled}
              onClick={() => props.state.onDock("bottom")}
            />
          }
        >
          <span class="tp-dock-modes" role="group" aria-label={t("terminal.dockMode")}>
            <For each={destinations()} keyed={(destination) => destination.dock}>
              {(destination) => (
                <openclaw-tooltip prop:content={destination().label}>
                  <ActionButton
                    label={destination().label}
                    icon={destination().icon}
                    disabled={props.state.dockDisabled}
                    onClick={() => props.state.onDock(destination().dock)}
                  />
                </openclaw-tooltip>
              )}
            </For>
          </span>
          <ActionButton
            class="rail-header__action tp-icon tp-open-fullscreen"
            label={t("terminal.openWindow")}
            icon="maximize"
            newTab
            onClick={props.state.onOpenFullscreen}
          />
          <ActionButton label={t("terminal.hide")} icon="x" onClick={props.state.onHide} />
        </Show>
      </Show>
    </div>
  );
}

function UploadLayer(props: { state: TerminalPanelViewState }) {
  const progress = createMemo(() => props.state.upload.progress);
  const label = createMemo(() => {
    const current = progress();
    return (
      current &&
      (current.state === "failed"
        ? t("terminal.uploadFailed")
        : t("terminal.uploadProgress", {
            current: String(current.current),
            total: String(current.total),
          }))
    );
  });
  return (
    <>
      <Show when={props.state.upload.dragActive}>
        <div class="tp-drop-overlay">{t("terminal.dropFiles")}</div>
      </Show>
      <Show when={progress()}>
        {(current) => (
          <div
            class={["tp-upload-card", { "tp-upload-card--failed": current().state === "failed" }]}
            role={current().state === "failed" ? "alert" : "status"}
            aria-live={current().state === "failed" ? "assertive" : "polite"}
          >
            <div class="tp-upload-card__header">
              <div class="tp-upload-card__copy">
                <div class="tp-upload-card__title">{label()}</div>
                <div class="tp-upload-card__file">{current().fileName}</div>
              </div>
              <div class="tp-upload-card__actions">
                <Show when={current().state === "failed" && current().retryable}>
                  <button
                    class="tp-upload-card__action tp-upload-retry"
                    type="button"
                    onClick={props.state.upload.retry}
                  >
                    {t("terminal.retryUpload")}
                  </button>
                </Show>
                <button
                  class="tp-upload-card__action tp-upload-cancel"
                  type="button"
                  onClick={props.state.upload.cancel}
                >
                  {t("common.cancel")}
                </button>
              </div>
            </div>
            <div
              class="tp-upload-progress"
              role="progressbar"
              aria-label={label() ?? undefined}
              aria-valuemin="0"
              aria-valuemax={String(current().total)}
              aria-valuenow={String(current().completed)}
            >
              <span
                class="tp-upload-progress__fill"
                style={{ width: `${(current().completed / current().total) * 100}%` }}
              />
              <Show when={current().state === "uploading"}>
                <span class="tp-upload-progress__activity" />
              </Show>
            </div>
            <Show when={current().error}>
              <div class="tp-upload-card__error">{current().error}</div>
            </Show>
            <Show when={current().state === "failed" && current().canInsert}>
              <div class="tp-upload-card__recovery">
                <button
                  class="tp-upload-card__action tp-upload-insert"
                  type="button"
                  onClick={props.state.upload.insertCompleted}
                >
                  {t("terminal.insertUploadedPaths")}
                </button>
              </div>
            </Show>
          </div>
        )}
      </Show>
    </>
  );
}

export function TerminalPanelView(props: { view: () => TerminalPanelViewState }) {
  const idPrefix = `terminal-${generateUUID()}`;
  const viewportId = `${idPrefix}-panel`;
  const dialogId = `${idPrefix}-session-picker-dialog`;
  const tabs = createMemo(() =>
    terminalPanelHostedTabs(props.view().tabs).map(({ icon: _icon, ...tab }) =>
      Object.assign(tab, {
        icon: (
          <svg
            viewBox="0 0 16 16"
            width="13"
            height="13"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M3 4l3 3-3 3M8 11h5" />
          </svg>
        ),
        domId: `${idPrefix}-tab-${tab.id}`,
        closeLabel: `${t("terminal.closeSession")}: ${tab.label}`,
      }),
    ),
  );
  return (
    <Show when={props.view().open}>
      <section
        class={`tp tp--${props.view().mode}`}
        style={props.view().style}
        aria-label={t("terminal.title")}
      >
        <Show when={!props.view().embedded}>
          <DockResizer
            controller={props.view().dockLayout}
            classPrefix="tp"
            label={t("terminal.resize")}
          />
        </Show>
        <Show
          when={!props.view().hosted}
          fallback={<SessionMenu state={props.view().picker} dialogId={dialogId} />}
        >
          <header class="rail-header tp-header">
            <PanelTabStrip
              tabs={tabs()}
              activeId={props.view().activeId}
              ariaControls={viewportId}
              onSelect={props.view().onSelect}
              onClose={props.view().onClose}
              onNew={props.view().onNew}
              newLabel={t("terminal.newSession")}
              newDisabled={props.view().booting}
            />
            <Actions state={props.view()} dialogId={dialogId} />
          </header>
        </Show>
        <Show when={props.view().error}>
          {(error) => (
            <div class="tp-error" role="alert">
              <span>{error().text}</span>
              <Show when={error().retry}>
                <button class="btn btn--sm" type="button" onClick={() => error().retry?.()}>
                  {t("common.retry")}
                </button>
              </Show>
            </div>
          )}
        </Show>
        <div
          id={viewportId}
          class="tp-viewport"
          role="tabpanel"
          aria-hidden="false"
          aria-labelledby={
            props.view().activeId && !props.view().hosted
              ? `${idPrefix}-tab-${props.view().activeId}`
              : undefined
          }
          aria-label={props.view().hosted ? t("terminal.title") : undefined}
          onDragEnter={(event: DragEvent) => props.view().upload.handleDragEnter(event)}
          onDragOver={(event: DragEvent) => props.view().upload.handleDragOver(event)}
          onDragLeave={(event: DragEvent) => props.view().upload.handleDragLeave(event)}
          onDrop={(event: DragEvent) => props.view().upload.handleDrop(event)}
        >
          <Show when={props.view().connecting}>
            <Loading overlay label={t("terminal.connecting")} />
          </Show>
          <Show when={!props.view().activeId && !props.view().connecting && !props.view().error}>
            {/* Defer the nested bridge mount until this parent's insertion is complete. */}
            <openclaw-panel-empty-state
              prop:heading={t("chat.sidePanel.terminal")}
              prop:description={t("chat.sidePanel.terminalEmpty")}
            >
              <Icon name="terminal" />
            </openclaw-panel-empty-state>
          </Show>
          <Show when={props.view().upload.uploadsEnabled()}>
            <input
              class="tp-file-input"
              type="file"
              multiple
              aria-hidden="true"
              tabindex="-1"
              onChange={(event) => props.view().upload.handleFileSelection(event)}
            />
          </Show>
          <UploadLayer state={props.view()} />
        </div>
      </section>
    </Show>
  );
}
