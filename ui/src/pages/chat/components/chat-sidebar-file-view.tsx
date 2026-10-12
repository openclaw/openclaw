import { createMemo, Show } from "solid-js";
import { localEditorFilePath } from "../../../app/native-editor-locality.runtime.ts";
import "../../../components/mcp-app-catalog.tsx";
import { Icon, type IconName } from "../../../components/solid/icon.tsx";
import { PanelLoadingSkeleton } from "../../../components/solid/panel-loading-skeleton.tsx";
import "../../../components/tooltip.ts";
import { registerCodeBlocksEnglish } from "../../../i18n/locales/en-code-blocks.ts";
import { registerFilePreviewEnglish } from "../../../i18n/locales/en-file-preview.ts";
import type { EditorId } from "../../../lib/editor-links.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { LitContent } from "../../../lit/solid-content.tsx";
import { getSafeLocalStorage } from "../../../local-storage.ts";
import type { FileCopyAction, FileCopyFeedback } from "./chat-file-copy-controller.ts";
import type { FileHtmlPreviewControls } from "./chat-html-preview.ts";
import type { FileSidebarContent, AttachmentSidebarRuntime } from "./chat-sidebar-content-types.ts";
import { ChatSidebarEditorMenu } from "./chat-sidebar-editor-menu.tsx";

registerCodeBlocksEnglish();
registerFilePreviewEnglish();

const FILE_WRAP_PREFERENCE_KEY = "openclaw.control.fileView.wrap.v1";

export function loadFileWrapPreference(): boolean {
  try {
    return getSafeLocalStorage()?.getItem(FILE_WRAP_PREFERENCE_KEY) === "true";
  } catch {
    return false;
  }
}

export function saveFileWrapPreference(wrap: boolean): void {
  try {
    getSafeLocalStorage()?.setItem(FILE_WRAP_PREFERENCE_KEY, String(wrap));
  } catch {
    // Preference persistence is best effort.
  }
}

export function hasUniformLineEndings(content: string): boolean {
  return new Set(content.match(/\r\n?|\n/g)).size <= 1;
}

export function computeFileMatches(content: string, query: string): number[] {
  const normalizedQuery = query.toLocaleLowerCase();
  if (!normalizedQuery) {
    return [];
  }
  return content
    .split(/\r\n?|\n/)
    .flatMap((line, index) =>
      line.toLocaleLowerCase().includes(normalizedQuery) ? [index + 1] : [],
    );
}

export type FileViewControls = {
  htmlPreview?: FileHtmlPreviewControls;
  copyFeedback: FileCopyFeedback;
  currentMatchIndex: number;
  dirty: boolean;
  execNode: string | null;
  editorMenuOpen: boolean;
  editing: boolean;
  loadingEditor: boolean;
  mountKey: number;
  matches: number[];
  query: string;
  saveNotice: { kind: "conflict" } | { kind: "error"; message: string } | null;
  saving: boolean;
  searchOpen: boolean;
  wrap: boolean;
  onCopy: (action: FileCopyAction) => void;
  onDiscard: () => void;
  onEdit: () => void;
  onNextMatch: () => void;
  onOpenEditor: (editor: EditorId) => void;
  onOverwrite: () => void;
  onPreviousMatch: () => void;
  onReload: () => void;
  onReveal?: (path: string) => void;
  onSave: () => void;
  onSearchInput: (query: string) => void;
  onSearchKeydown: (event: KeyboardEvent) => void;
  onEditorMenuOpenChange: (open: boolean) => void;
  onToggleSearch: () => void;
  onToggleWrap: () => void;
};

function FileAction(props: {
  label: string;
  icon: IconName;
  onClick: () => void;
  class?: string;
  pressed?: boolean;
  disabled?: boolean;
}) {
  return (
    <openclaw-tooltip prop:content={props.label}>
      <button
        class={["btn btn--sm sidebar-file-view__action", props.class]}
        type="button"
        aria-label={props.label}
        aria-pressed={props.pressed === undefined ? undefined : props.pressed ? "true" : "false"}
        disabled={props.disabled}
        onClick={() => props.onClick()}
      >
        <Icon name={props.icon} />
      </button>
    </openclaw-tooltip>
  );
}

function FileCopyButton(props: { action: FileCopyAction; controls?: FileViewControls }) {
  const feedback = () => props.controls?.copyFeedback[props.action];
  return (
    <FileAction
      label={t(
        feedback() === "failed"
          ? "common.copyFailed"
          : feedback() === "copied"
            ? "common.copied"
            : props.action === "path"
              ? "chat.detailPanel.copyPath"
              : "chat.detailPanel.copyContents",
      )}
      icon={feedback() === "copied" ? "check" : "copy"}
      onClick={() => props.controls?.onCopy(props.action)}
      class={feedback() === "copied" ? "copied" : ""}
    />
  );
}

function FileTextAction(props: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      class="btn btn--sm"
      type="button"
      disabled={props.disabled}
      onClick={() => props.onClick()}
    >
      {props.label}
    </button>
  );
}

export function SidebarFile(props: {
  content: FileSidebarContent;
  onViewRawText: () => void;
  controls?: FileViewControls;
  runtime?: AttachmentSidebarRuntime;
}) {
  const mountKey = createMemo(() => props.controls?.mountKey ?? props.content);
  // Wrap the key so the initial zero key also mounts; only an identity change replaces the editor host.
  const mountIdentity = createMemo(() => ({ key: mountKey() }));
  return (
    <section class={["sidebar-file-view", { "sidebar-file-view--wrap": props.controls?.wrap }]}>
      <div class="sidebar-file-view__path-bar">
        <div class="sidebar-file-view__path-field">
          <span class="sidebar-file-view__path" title={props.content.path}>
            {props.content.path}
          </span>
          <FileCopyButton action="path" controls={props.controls} />
          <openclaw-mcp-app-catalog
            surface="file"
            prop:sessionKey={
              props.runtime?.sessionKey ?? props.content.draftContext?.sessionKey ?? ""
            }
            prop:agentId={props.runtime?.agentId ?? ""}
            prop:filePath={props.content.path}
          />
        </div>
        <Show when={props.controls}>
          {(controls) => (
            <div class="sidebar-file-view__actions">
              <Show when={!controls().htmlPreview || controls().htmlPreview?.source}>
                <FileAction
                  label={t(
                    controls().wrap ? "chat.codeBlock.disableWrap" : "chat.codeBlock.enableWrap",
                  )}
                  icon="wrapText"
                  onClick={() => controls().onToggleWrap()}
                  class="sidebar-file-view__wrap"
                  pressed={controls().wrap}
                />
              </Show>
              <Show when={controls().htmlPreview}>
                {(preview) => (
                  <button
                    class="btn btn--sm"
                    type="button"
                    aria-pressed={preview().source ? "true" : "false"}
                    onClick={() => preview().onToggle()}
                  >
                    {preview().source
                      ? t("chat.workspaceFiles.preview")
                      : t("chat.detailPanel.viewSource")}
                  </button>
                )}
              </Show>
              <Show
                when={controls().editing}
                fallback={
                  <>
                    <Show when={props.content.edit}>
                      <FileAction
                        label={t("chat.detailPanel.editFile")}
                        icon="edit"
                        onClick={() => controls().onEdit()}
                        disabled={controls().loadingEditor}
                      />
                    </Show>
                    <FileAction
                      label={t("chat.detailPanel.searchInFile")}
                      icon="search"
                      onClick={() => controls().onToggleSearch()}
                      class="sidebar-file-view__search-toggle"
                      pressed={controls().searchOpen}
                    />
                    <Show when={controls().onReveal}>
                      <FileAction
                        label={t("chat.detailPanel.showInFiles")}
                        icon="folder"
                        onClick={() => controls().onReveal?.(props.content.path)}
                      />
                    </Show>
                    <ChatSidebarEditorMenu
                      absolutePath={localEditorFilePath(props.content, controls().execNode)}
                      open={controls().editorMenuOpen}
                      onOpenChange={(open) => controls().onEditorMenuOpenChange(open)}
                      onOpenEditor={(editor) => controls().onOpenEditor(editor)}
                    />
                    <FileCopyButton action="contents" controls={controls()} />
                  </>
                }
              >
                <FileTextAction
                  label={t(controls().saving ? "common.saving" : "common.save")}
                  onClick={() => controls().onSave()}
                  disabled={!controls().dirty || controls().saving}
                />
                <FileTextAction
                  label={t("chat.detailPanel.discard")}
                  onClick={() => controls().onDiscard()}
                  disabled={controls().saving}
                />
              </Show>
            </div>
          )}
        </Show>
      </div>
      <Show when={Object.values(props.controls?.copyFeedback ?? {}).includes("failed")}>
        <div class="file-view__save-notice" role="alert">
          {t("common.copyFailed")}
        </div>
      </Show>
      <Show when={props.controls?.searchOpen && props.controls}>
        {(controls) => (
          <div class="file-view__search" onKeyDown={(event) => controls().onSearchKeydown(event)}>
            <input
              type="search"
              aria-label={t("chat.detailPanel.searchInFile")}
              placeholder={t("common.search")}
              value={controls().query}
              onInput={(event) => controls().onSearchInput(event.currentTarget.value)}
            />
            <span class="file-view__search-counter" role="status">
              {controls().matches.length ? controls().currentMatchIndex + 1 : 0}/
              {controls().matches.length}
            </span>
            <button
              class="btn btn--sm file-view__search-action file-view__search-action--previous"
              type="button"
              aria-label={t("chat.detailPanel.previousMatch")}
              disabled={!controls().matches.length}
              onClick={() => controls().onPreviousMatch()}
            >
              <Icon name="chevronDown" />
            </button>
            <button
              class="btn btn--sm file-view__search-action"
              type="button"
              aria-label={t("chat.detailPanel.nextMatch")}
              disabled={!controls().matches.length}
              onClick={() => controls().onNextMatch()}
            >
              <Icon name="chevronDown" />
            </button>
          </div>
        )}
      </Show>
      <Show when={props.controls?.saveNotice}>
        {(notice) => (
          <div class="file-view__save-notice" role="alert">
            <span>
              {(() => {
                const value = notice();
                return value.kind === "conflict"
                  ? t("chat.detailPanel.fileChanged")
                  : value.message;
              })()}
            </span>
            <Show when={notice().kind === "conflict"}>
              <div class="file-view__save-notice-actions">
                <FileTextAction
                  label={t("common.reload")}
                  onClick={() => props.controls?.onReload()}
                  disabled={props.controls?.saving}
                />
                <FileTextAction
                  label={t("chat.detailPanel.overwrite")}
                  onClick={() => props.controls?.onOverwrite()}
                  disabled={props.controls?.saving}
                />
              </div>
            </Show>
          </div>
        )}
      </Show>
      <Show when={props.controls?.htmlPreview}>
        {(preview) => (
          <div class="chat-html-preview" hidden={preview().source}>
            <LitContent value={preview().presentation} />
          </div>
        )}
      </Show>
      <div
        class="file-view"
        hidden={Boolean(props.controls?.htmlPreview && !props.controls.htmlPreview.source)}
      >
        <Show when={props.controls?.htmlPreview?.sourceFallback}>
          {(fallback) => <LitContent value={fallback()} />}
        </Show>
        <Show when={mountIdentity()} keyed>
          {(_identity) => <div class="file-view__mount" />}
        </Show>
        <Show when={props.controls?.loadingEditor}>
          <PanelLoadingSkeleton
            variant="review"
            label={t("common.loading")}
            compact={false}
            overlay
          />
        </Show>
      </div>
      <Show when={!props.controls?.editing && !props.controls?.htmlPreview}>
        <div class="sidebar-file-view__footer">
          <FileTextAction
            label={t("chat.detailPanel.viewRawText")}
            onClick={() => props.onViewRawText()}
          />
        </div>
      </Show>
    </section>
  );
}
