import { html, nothing, type TemplateResult } from "lit";
import "../../../components/mcp-app-catalog.tsx";
import { keyed } from "lit/directives/keyed.js";
import { localEditorFilePath } from "../../../app/native-editor-locality.runtime.ts";
import { icons } from "../../../components/icons.ts";
import { renderPanelLoadingSkeleton } from "../../../components/panel-loading-skeleton.ts";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import { registerCodeBlocksEnglish } from "../../../i18n/locales/en-code-blocks.ts";
import { registerFilePreviewEnglish } from "../../../i18n/locales/en-file-preview.ts";
import type { EditorId } from "../../../lib/editor-links.ts";
import { getSafeLocalStorage } from "../../../local-storage.ts";
import type { FileCopyAction, FileCopyFeedback } from "./chat-file-copy-controller.ts";
import type { FileSidebarContent, AttachmentSidebarRuntime } from "./chat-sidebar-content-types.ts";
import { renderChatSidebarEditorMenu } from "./chat-sidebar-editor-menu.ts";

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
  htmlPreview?: {
    source: boolean;
    presentation: TemplateResult | typeof nothing;
    sourceFallback?: TemplateResult;
    onToggle: () => void;
  };
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

function renderFileAction({
  label,
  icon,
  onClick,
  className = "",
  pressed,
  disabled = false,
}: {
  label: string;
  icon: TemplateResult;
  onClick: () => void;
  className?: string;
  pressed?: boolean;
  disabled?: boolean;
}) {
  return html`
    <openclaw-tooltip .content=${label}>
      <button
        class="btn btn--sm sidebar-file-view__action ${className}"
        type="button"
        aria-label=${label}
        aria-pressed=${pressed === undefined ? nothing : String(pressed)}
        ?disabled=${disabled}
        @click=${onClick}
      >
        ${icon}
      </button>
    </openclaw-tooltip>
  `;
}

function renderFileCopyButton(action: FileCopyAction, controls?: FileViewControls) {
  const feedback = controls?.copyFeedback[action];
  const label = t(
    feedback === "failed"
      ? "common.copyFailed"
      : feedback === "copied"
        ? "common.copied"
        : action === "path"
          ? "chat.detailPanel.copyPath"
          : "chat.detailPanel.copyContents",
  );
  return renderFileAction({
    label,
    icon: feedback === "copied" ? icons.check : icons.copy,
    onClick: () => controls?.onCopy(action),
    className: feedback === "copied" ? "copied" : "",
  });
}

function renderFileTextAction(label: string, onClick: () => void, disabled = false) {
  return html`<button class="btn btn--sm" type="button" ?disabled=${disabled} @click=${onClick}>
    ${label}
  </button>`;
}

export function renderSidebarFile(
  content: FileSidebarContent,
  onViewRawText: () => void,
  controls?: FileViewControls,
  runtime?: AttachmentSidebarRuntime,
) {
  const absolutePath = localEditorFilePath(content, controls?.execNode);
  const matchNumber = controls?.matches.length ? controls.currentMatchIndex + 1 : 0;
  return html`
    <section class="sidebar-file-view ${controls?.wrap ? "sidebar-file-view--wrap" : ""}">
      <div class="sidebar-file-view__path-bar">
        <div class="sidebar-file-view__path-field">
          <span class="sidebar-file-view__path" title=${content.path}>${content.path}</span>
          ${renderFileCopyButton("path", controls)}
          <openclaw-mcp-app-catalog
            surface="file"
            .sessionKey=${runtime?.sessionKey ?? content.draftContext?.sessionKey ?? ""}
            .agentId=${runtime?.agentId ?? ""}
            .filePath=${content.path}
          ></openclaw-mcp-app-catalog>
        </div>
        ${
          controls
            ? html`
                <div class="sidebar-file-view__actions">
                  ${
                    !controls.htmlPreview || controls.htmlPreview.source
                      ? renderFileAction({
                          label: t(
                            controls.wrap
                              ? "chat.codeBlock.disableWrap"
                              : "chat.codeBlock.enableWrap",
                          ),
                          icon: icons.wrapText,
                          onClick: controls.onToggleWrap,
                          className: "sidebar-file-view__wrap",
                          pressed: controls.wrap,
                        })
                      : nothing
                  }
                  ${
                    controls.htmlPreview
                      ? html`<button
                          class="btn btn--sm"
                          type="button"
                          aria-pressed=${String(controls.htmlPreview.source)}
                          @click=${controls.htmlPreview.onToggle}
                        >
                          ${controls.htmlPreview.source ? t("chat.workspaceFiles.preview") : t("chat.detailPanel.viewSource")}
                        </button>`
                      : nothing
                  }
                  ${
                    controls.editing
                      ? html`
                          ${renderFileTextAction(
                            t(controls.saving ? "common.saving" : "common.save"),
                            controls.onSave,
                            !controls.dirty || controls.saving,
                          )}
                          ${renderFileTextAction(t("chat.detailPanel.discard"), controls.onDiscard, controls.saving)}
                        `
                      : html`
                          ${
                            content.edit
                              ? renderFileAction({
                                  label: t("chat.detailPanel.editFile"),
                                  icon: icons.edit,
                                  onClick: controls.onEdit,
                                  disabled: controls.loadingEditor,
                                })
                              : nothing
                          }
                          ${renderFileAction({
                            label: t("chat.detailPanel.searchInFile"),
                            icon: icons.search,
                            onClick: controls.onToggleSearch,
                            className: "sidebar-file-view__search-toggle",
                            pressed: controls.searchOpen,
                          })}
                          ${
                            controls.onReveal
                              ? renderFileAction({
                                  label: t("chat.detailPanel.showInFiles"),
                                  icon: icons.folder,
                                  onClick: () => controls.onReveal?.(content.path),
                                })
                              : nothing
                          }
                          ${renderChatSidebarEditorMenu({
                            absolutePath,
                            open: controls.editorMenuOpen,
                            onOpenChange: controls.onEditorMenuOpenChange,
                            onOpenEditor: controls.onOpenEditor,
                          })}
                          ${renderFileCopyButton("contents", controls)}
                        `
                  }
                </div>
              `
            : nothing
        }
      </div>
      ${
        Object.values(controls?.copyFeedback ?? {}).includes("failed")
          ? html`<div class="file-view__save-notice" role="alert">${t("common.copyFailed")}</div>`
          : nothing
      }
      ${
        controls?.searchOpen
          ? html`
              <div class="file-view__search" @keydown=${controls.onSearchKeydown}>
                <input
                  type="search"
                  aria-label=${t("chat.detailPanel.searchInFile")}
                  placeholder=${t("common.search")}
                  .value=${controls.query}
                  @input=${(event: Event & { currentTarget: HTMLInputElement }) =>
                    controls.onSearchInput(event.currentTarget.value)}
                />
                <span class="file-view__search-counter" role="status"
                  >${matchNumber}/${controls.matches.length}</span
                >
                ${(
                  [
                    [
                      "chat.detailPanel.previousMatch",
                      controls.onPreviousMatch,
                      " file-view__search-action--previous",
                    ],
                    ["chat.detailPanel.nextMatch", controls.onNextMatch, ""],
                  ] as const
                ).map(
                  ([label, onClick, className]) => html`<button
                    class="btn btn--sm file-view__search-action${className}"
                    type="button"
                    aria-label=${t(label)}
                    ?disabled=${controls.matches.length === 0}
                    @click=${onClick}
                  >
                    ${icons.chevronDown}
                  </button>`,
                )}
              </div>
            `
          : nothing
      }
      ${
        controls?.saveNotice
          ? html`
              <div class="file-view__save-notice" role="alert">
                <span>
                  ${
                    controls.saveNotice.kind === "conflict"
                      ? t("chat.detailPanel.fileChanged")
                      : controls.saveNotice.message
                  }
                </span>
                ${
                  controls.saveNotice.kind === "conflict"
                    ? html`
                        <div class="file-view__save-notice-actions">
                          ${renderFileTextAction(t("common.reload"), controls.onReload, controls.saving)}
                          ${renderFileTextAction(t("chat.detailPanel.overwrite"), controls.onOverwrite, controls.saving)}
                        </div>
                      `
                    : nothing
                }
              </div>
            `
          : nothing
      }
      ${
        controls?.htmlPreview
          ? html`<div class="chat-html-preview" ?hidden=${controls.htmlPreview.source}>
              ${controls.htmlPreview.presentation}
            </div>`
          : nothing
      }
      <div class="file-view" ?hidden=${controls?.htmlPreview && !controls.htmlPreview.source}>
        ${controls?.htmlPreview?.sourceFallback ?? nothing}
        ${keyed(controls?.mountKey ?? content, html`<div class="file-view__mount"></div>`)}
        ${
          controls?.loadingEditor
            ? renderPanelLoadingSkeleton("review", t("common.loading"), false, true)
            : nothing
        }
      </div>
      ${
        controls?.editing || controls?.htmlPreview
          ? nothing
          : html`
              <div class="sidebar-file-view__footer">
                ${renderFileTextAction(t("chat.detailPanel.viewRawText"), onViewRawText)}
              </div>
            `
      }
    </section>
  `;
}
