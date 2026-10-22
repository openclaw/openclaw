import { For, Show, createMemo } from "solid-js";
import { t } from "../../lib/reactive/i18n.ts";
import { createTabFocus } from "../../lib/tabs.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { DockResizer } from "../dock-layout-solid.tsx";
import { PanelTabStrip } from "../panel-tab-strip-solid.tsx";
import { Icon } from "../solid/icon.tsx";
import { PanelEmptyState } from "../solid/panel-empty-state.tsx";
import { PanelIconButton } from "../solid/panel-icon-button.tsx";
import { PanelLoadingSkeleton } from "../solid/panel-loading-skeleton.tsx";
import { terminalPanelTabIcon, terminalPanelHostedTabs } from "./terminal-panel-tabs.tsx";
import { Actions, SessionMenu, TerminalRail } from "./terminal-panel-view-chrome.tsx";
import type { TerminalPanelViewState } from "./terminal-panel-view-types.ts";

function UploadLayer(props: { state: TerminalPanelViewState }) {
  const progress = createMemo(() => props.state.upload.progress());
  const label = () => {
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
  };
  return (
    <>
      <Show when={props.state.upload.dragActive()}>
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
                    disabled={!props.state.connected}
                    onClick={() => props.state.upload.retry()}
                  >
                    {t("terminal.retryUpload")}
                  </button>
                </Show>
                <button
                  class="tp-upload-card__action tp-upload-cancel"
                  type="button"
                  onClick={() => props.state.upload.cancel()}
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
                  disabled={!props.state.connected}
                  onClick={() => props.state.upload.insertCompleted()}
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

function TerminalComposer(props: { state: TerminalPanelViewState }) {
  return (
    <Show when={props.state.activeTab?.status === "live"}>
      <Show when={props.state.attachments.length}>
        <div class="tp-attachments">
          <For each={props.state.attachments} keyed={(attachment) => attachment}>
            {(attachment, index) => (
              <span class="tp-attachment">
                <Icon name="paperclip" />
                <span title={attachment().name}>{attachment().name}</span>
                <PanelIconButton
                  class="tp-attachment__remove"
                  label={`${t("common.remove")}: ${attachment().name}`}
                  icon={<Icon name="x" />}
                  onClick={() => props.state.onRemoveAttachment(index())}
                />
              </span>
            )}
          </For>
        </div>
      </Show>
      <form
        class="tp-composer"
        onSubmit={(event) => {
          event.preventDefault();
          props.state.onSubmit();
        }}
      >
        <span class="tp-composer__prompt" aria-hidden="true">
          ›
        </span>
        <input
          aria-label={t("terminal.inputLabel")}
          value={props.state.draft}
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          onInput={(event) => props.state.onDraft(event.currentTarget.value)}
        />
        <Show when={!props.state.mobile && props.state.upload.uploadsEnabled()}>
          <PanelIconButton
            class="tp-composer__attach tp-upload"
            label={t("terminal.addFiles")}
            icon={<Icon name="paperclip" />}
            disabled={
              !props.state.connected ||
              props.state.upload.hasPendingBatch() ||
              !props.state.upload.hasActiveTab()
            }
            onClick={props.state.upload.chooseFiles}
          />
        </Show>
        <button
          class="tp-composer__submit"
          type="submit"
          aria-label={t("terminal.sendInput")}
          disabled={
            !props.state.connected || (!props.state.draft.trim() && !props.state.attachments.length)
          }
        >
          <Icon name="arrowUp" />
        </button>
      </form>
    </Show>
  );
}

export function TerminalPanelView(props: { view: () => TerminalPanelViewState }) {
  const tabFocus = createTabFocus();
  const idPrefix = `terminal-${generateUUID()}`;
  const viewportId = `${idPrefix}-panel`;
  const dialogId = `${idPrefix}-session-picker-dialog`;
  const tabs = createMemo(() =>
    terminalPanelHostedTabs(props.view().tabs, props.view().connected).map((tab) =>
      Object.assign(tab, {
        icon: terminalPanelTabIcon(),
        domId: `${idPrefix}-tab-${tab.id}`,
        closeLabel: `${t("terminal.closeSession")}: ${tab.label}`,
      }),
    ),
  );
  return (
    <Show when={props.view().open}>
      <section
        class={["tp", `tp--${props.view().mode}`, { "tp--mobile": props.view().mobile }]}
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
        <Show when={!props.view().hosted}>
          <header class="rail-header tp-header">
            <PanelTabStrip
              focusOwner={tabFocus}
              presentation={props.view().mobile ? "mobile" : "desktop"}
              tabs={tabs()}
              activeId={props.view().activeId}
              ariaControls={viewportId}
              onSelect={props.view().onSelect}
              onClose={props.view().onClose}
              onNew={props.view().onNew}
              newLabel={t("terminal.newSession")}
              newDisabled={!props.view().connected || props.view().booting}
            />
            <Actions state={props.view()} dialogId={dialogId} />
          </header>
        </Show>
        <Show when={!props.view().connected}>
          <div class="tp-error" role="status">
            {t("terminal.inputPaused")}
          </div>
        </Show>
        <Show when={props.view().error}>
          {(error) => (
            <div class="tp-error" role="alert">
              <span>{error().text}</span>
              <Show when={error().retry}>
                <button
                  class="btn btn--sm"
                  type="button"
                  disabled={!props.view().connected}
                  onClick={() => error().retry?.()}
                >
                  {t("common.retry")}
                </button>
              </Show>
            </div>
          )}
        </Show>
        <div class="tp-content">
          <Show when={props.view().embedded}>
            <SessionMenu
              state={props.view().picker}
              dialogId={dialogId}
              inline
              mobile={props.view().mobile}
              onNew={props.view().onNew}
              dockDisabled={props.view().dockDisabled}
              onDock={props.view().fullscreen ? undefined : () => props.view().onDock("bottom")}
            />
            <Show when={!props.view().picker.open()}>
              <TerminalRail state={props.view()} />
            </Show>
          </Show>
          <div
            id={viewportId}
            ref={(element) => props.view().viewportRef(element)}
            class={[
              "tp-viewport",
              { "tp-viewport--covered": props.view().embedded && props.view().picker.open() },
            ]}
            inert={props.view().embedded && props.view().picker.open()}
            aria-disabled={props.view().connected ? "false" : "true"}
            role="tabpanel"
            aria-hidden={props.view().embedded && props.view().picker.open() ? "true" : "false"}
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
              <PanelLoadingSkeleton variant="terminal" overlay label={t("terminal.connecting")} />
            </Show>
            <Show when={!props.view().activeId && !props.view().connecting && !props.view().error}>
              <PanelEmptyState
                heading={t("chat.sidePanel.terminal")}
                description={t("chat.sidePanel.terminalEmpty")}
                icon={<Icon name="terminal" />}
              />
            </Show>
            <Show when={props.view().upload.uploadsEnabled()}>
              <input
                ref={(element) => props.view().fileInputRef(element)}
                class="tp-file-input"
                type="file"
                multiple
                aria-hidden="true"
                tabindex="-1"
                onChange={(event) => props.view().upload.handleFileSelection(event)}
              />
            </Show>
          </div>
          <UploadLayer state={props.view()} />
          <Show when={props.view().embedded && !props.view().picker.open()}>
            <TerminalComposer state={props.view()} />
          </Show>
        </div>
      </section>
    </Show>
  );
}
