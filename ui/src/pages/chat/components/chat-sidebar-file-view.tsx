import { createMemo, onSettled, Show } from "solid-js";
import { localEditorFilePath } from "../../../app/native-editor-locality.runtime.ts";
import { createMarkdownRef } from "../../../components/markdown-dom-ref.ts";
import { toSanitizedMarkdownHtml } from "../../../components/markdown.ts";
import { McpAppCatalog } from "../../../components/mcp-app-catalog.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { PanelLoadingSkeleton } from "../../../components/solid/panel-loading-skeleton.tsx";
import { registerCodeBlocksEnglish } from "../../../i18n/locales/en-code-blocks.ts";
import "../../../components/tooltip.ts";
import { registerFilePreviewEnglish } from "../../../i18n/locales/en-file-preview.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { createLayoutMeasurement } from "../../../lib/reactive/layout-measurement.ts";
import { getSafeLocalStorage } from "../../../local-storage.ts";
import { FileDownloadButton } from "./chat-file-download-button.tsx";
import "../../../styles/session-panel-rail.css";

import type { FileViewControls } from "./chat-file-reader-controls.ts";
import { measureFileScroll } from "./chat-file-scroll.ts";
import { HtmlPreview, HtmlPreviewSourceFallback } from "./chat-html-preview-view.tsx";
import type { FileSidebarContent, AttachmentSidebarRuntime } from "./chat-sidebar-content-types.ts";
import { ChatSidebarEditorMenu } from "./chat-sidebar-editor-menu.tsx";
import { DesktopFileChrome, FileCopyButton, FileTextAction } from "./chat-sidebar-file-chrome.tsx";
import {
  SidebarFileMobileRail,
  SidebarFileMobileTextControls,
  mobileFileTextMenuActions,
} from "./chat-sidebar-file-mobile.tsx";

export { DesktopFileNavigation, FileAction } from "./chat-sidebar-file-chrome.tsx";

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

function FileMarkdown(props: { controls: FileViewControls; onSelect: (event: Event) => void }) {
  let scroll!: HTMLDivElement;
  let article!: HTMLElement;
  onSettled(() => {
    const releaseScroll = props.controls.onScrollPortRef?.(scroll);
    const releaseArticle = props.controls.onScrollPortRef?.(article);
    return () => {
      releaseScroll?.();
      releaseArticle?.();
    };
  });
  const markdownRef = createMarkdownRef(() => ({
    incremental: true,
    content: toSanitizedMarkdownHtml(
      props.controls.markdown?.content ?? "",
      props.controls.markdown?.options,
    ),
  }));
  const schedule = createLayoutMeasurement(
    () => [props.controls.presentation, props.controls.markdown],
    () => measureFileScroll(scroll, props.controls.presentation === "mobile"),
    { targets: () => [scroll, article] },
  );
  return (
    <div
      class="sidebar-file-view__markdown-scroll"
      onScroll={schedule}
      ref={(element) => {
        scroll = element;
      }}
    >
      <article
        ref={(element) => {
          article = element;
          markdownRef(element);
        }}
        class="sidebar-markdown sidebar-file-view__markdown"
        onPointerUp={(event) => props.onSelect(event)}
        onKeyUp={(event) => props.onSelect(event)}
      />
    </div>
  );
}

export function SidebarFile(props: {
  content: FileSidebarContent;
  onViewRawText: () => void;
  controls?: FileViewControls;
  runtime?: AttachmentSidebarRuntime;
}) {
  const desktop = () => props.controls?.presentation !== "mobile";
  const mobile = () => props.controls?.presentation === "mobile";
  const mobileSource = () =>
    props.controls?.htmlPreview?.source ?? props.controls?.readingMode !== "preview";
  const selectMarkdown = (event: Event) => {
    const selection = document.getSelection();
    if (
      selection &&
      !selection.isCollapsed &&
      event.currentTarget instanceof Element &&
      event.currentTarget.contains(selection.anchorNode)
    ) {
      props.controls?.onSelectContent?.();
    }
  };
  const mountKey = createMemo(() => props.controls?.mountKey ?? props.content);
  // Wrap the key so the initial zero key also mounts; only an identity change replaces the editor host.
  const mountIdentity = createMemo(() => ({ key: mountKey() }));
  return (
    <section
      class={[
        "sidebar-file-view",
        {
          "sidebar-file-view--wrap": props.controls?.wrap,
          "sidebar-file-view--desktop": desktop(),
          "sidebar-file-view--mobile": mobile(),
          "sidebar-file-view--editing": props.controls?.editing,
        },
      ]}
    >
      {/* Folder navigation hides the chrome; its retiring children still need valid controls. */}
      <Show when={props.controls}>
        {(controls) => (
          <Show when={desktop() && !controls().workspace?.showingFolder}>
            <DesktopFileChrome
              content={props.content}
              controls={controls()}
              runtime={props.runtime}
            />
          </Show>
        )}
      </Show>
      <Show when={mobile() && props.controls}>
        {(controls) => (
          <SidebarFileMobileRail
            name={props.content.name}
            identity={props.content.path}
            back={controls().back}
            menuActions={mobileFileTextMenuActions({
              controls: controls(),
              path: props.content.path,
              source: mobileSource(),
            })}
            actions={
              <>
                <McpAppCatalog
                  surface="file"
                  sessionKey={
                    props.runtime?.sessionKey ?? props.content.draftContext?.sessionKey ?? ""
                  }
                  agentId={props.runtime?.agentId ?? ""}
                  filePath={props.content.path}
                />
                <Show when={props.content.download}>
                  {(download) => (
                    <FileDownloadButton
                      scopeKey={[
                        props.runtime?.sessionKey,
                        props.content.path,
                        props.content.sessionFileSource?.messageEntryId,
                        props.runtime?.connectionEpoch,
                      ].join("\0")}
                      download={(signal) => download()(signal)}
                      class="sidebar-file-mobile__button"
                    />
                  )}
                </Show>
                <ChatSidebarEditorMenu
                  absolutePath={localEditorFilePath(props.content, controls().execNode)}
                  open={controls().editorMenuOpen}
                  onOpenChange={(open) => controls().onEditorMenuOpenChange(open)}
                  onOpenEditor={(editor) => controls().onOpenEditor(editor)}
                />
              </>
            }
          />
        )}
      </Show>
      <Show when={Object.values(props.controls?.copyFeedback ?? {}).includes("failed")}>
        <div class="file-view__save-notice" role="alert">
          {t("common.copyFailed")}
        </div>
      </Show>
      <Show when={!mobile() && props.controls?.searchOpen && props.controls}>
        {(controls) => (
          <div class="file-view__search" onKeyDown={(event) => controls().onSearchKeydown(event)}>
            <input
              type="search"
              ref={controls().searchInputRef}
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
      <div class="sidebar-file-view__workspace-body">
        <div
          class={["sidebar-file-view__document", { "sidebar-file-mobile__body": mobile() }]}
          hidden={!mobile() && props.controls?.workspace?.showingFolder}
        >
          <Show when={props.controls?.htmlPreview}>
            {(preview) => (
              <div class="chat-html-preview" hidden={preview().source}>
                <Show when={preview().presentation}>
                  {(presentation) => <HtmlPreview {...presentation()} desktop={!mobile()} />}
                </Show>
              </div>
            )}
          </Show>
          <div
            class="sidebar-file-view__canvas"
            hidden={Boolean(props.controls?.htmlPreview && !props.controls.htmlPreview.source)}
          >
            <Show when={desktop()}>
              <div class="sidebar-file-view__floating-copy">
                <FileCopyButton controls={props.controls} />
              </div>
            </Show>
            <Show when={props.controls?.markdown && props.controls.readingMode === "preview"}>
              <FileMarkdown controls={props.controls!} onSelect={selectMarkdown} />
            </Show>
            <div
              class="file-view"
              hidden={
                props.controls?.readingMode === "preview" ||
                Boolean(props.controls?.htmlPreview && !props.controls.htmlPreview.source)
              }
            >
              <Show when={props.controls?.htmlPreview?.sourceFallback}>
                {(fallback) => <HtmlPreviewSourceFallback {...fallback()} />}
              </Show>
              <Show when={mountIdentity()} keyed>
                {(_identity) => (
                  // The editor mount retains its callback through control replacement.
                  <div class="file-view__mount" ref={props.controls?.editorRef} />
                )}
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
          </div>
          <Show when={mobile() && props.controls}>
            {(controls) => (
              <SidebarFileMobileTextControls
                controls={controls()}
                canEdit={Boolean(props.content.edit)}
                active={controls().active !== false}
                mode={
                  controls().htmlPreview ??
                  (controls().markdown
                    ? {
                        source: mobileSource(),
                        onToggle: () =>
                          controls().onReadingModeChange?.(
                            mobileSource() ? "preview" : "highlighted",
                          ),
                      }
                    : undefined)
                }
                onCloseFind={(reason) => controls().onCloseSearch?.(reason)}
              />
            )}
          </Show>
        </div>
      </div>
    </section>
  );
}
