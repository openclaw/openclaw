import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { AgentFileEntry } from "../../api/types.ts";
import { renderHubTabs } from "../../components/hub-tabs.ts";
import { icons } from "../../components/icons.ts";
import { toSanitizedMarkdownHtml } from "../../components/markdown.ts";
import "../../components/modal-dialog.ts";
import type { OpenClawModalDialog } from "../../components/modal-dialog.ts";
import "../../components/tooltip.ts";
import { renderSettingsEmpty, renderSettingsSection } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { formatBytes } from "../../lib/agents/display.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { pathDisplayName } from "../../lib/path-display.ts";
import { resetAgentFilePreview, setPreviewExpandButtonState } from "./agent-file-preview-state.ts";
import { agentFilePreview } from "./agent-file-preview.ts";
import { renderAgentFileError } from "./file-conflict-callout.ts";
import { hasAgentFileContent, type AgentFilesViewState } from "./files.ts";
import { renderAgentPanelAction } from "./panel-ui.ts";

function getExtensionLabel(fileName: string) {
  const ext = fileName.split(".").pop()?.trim().toLowerCase();
  if (ext === "md" || ext === "markdown") {
    return t("agents.files.markdownPreview");
  }
  return ext
    ? t("agents.files.extensionPreview", { ext: ext.toUpperCase() })
    : t("agents.files.preview");
}

function formatWorkspaceRelativePath(filePath: string, workspace: string | null | undefined) {
  const normalizedPath = filePath.trim();
  const normalizedWorkspace = workspace?.trim();
  if (!normalizedPath) {
    return "";
  }
  if (normalizedWorkspace && normalizedPath === normalizedWorkspace) {
    return ".";
  }
  if (normalizedWorkspace && normalizedPath.startsWith(`${normalizedWorkspace}/`)) {
    return normalizedPath.slice(normalizedWorkspace.length + 1) || ".";
  }
  return pathDisplayName(normalizedPath);
}

function toDomId(value: string) {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return normalized.replace(/^-+|-+$/g, "") || "preview";
}

function renderPreviewFact(value: string | number, label: string, secondary = false) {
  return html`
    <div class="md-preview-dialog__chip" data-priority=${secondary ? "secondary" : "essential"}>
      <strong>${value}</strong>
      <span>${label}</span>
    </div>
  `;
}

function closeAgentFilePreview(event: Event, focusEditor = false) {
  const button = event.currentTarget;
  if (!(button instanceof HTMLElement)) {
    return;
  }
  const modal = button.closest<OpenClawModalDialog>("openclaw-modal-dialog");
  if (!modal) {
    return;
  }
  if (focusEditor) {
    const textarea = modal
      .closest(".settings-group")
      ?.querySelector<HTMLElement>(".agent-file-textarea");
    modal.setReturnFocusTarget(textarea ?? null);
  }
  modal.hide();
  resetAgentFilePreview(modal);
}

export function renderAgentFiles(
  params: AgentFilesViewState & {
    agentId: string;
    canWrite: boolean;
    onLoadFiles: (agentId: string) => void;
    onSelectFile: (name: string) => void;
    onFileDraftChange: (name: string, content: string) => void;
    onFileReset: (name: string) => void;
    onFileSave: (name: string) => void;
    onFileReload: (name: string) => void;
    onFileOverwrite: (name: string) => void;
  },
) {
  const list = params.agentFilesList?.agentId === params.agentId ? params.agentFilesList : null;
  const files = list?.files ?? [];
  const active = params.agentFileActive ?? null;
  // Files whose absence is a normal workspace state stay out of the tab strip until
  // the operator picks them; only a genuinely faulty absence is badged as missing.
  const isCreatable = (file: AgentFileEntry) =>
    file.missing && file.expectedAbsent === true && file.name !== active;
  const tabFiles = files.filter((file) => !isCreatable(file));
  const creatableFiles = files.filter(isCreatable);
  const activeEntry = active ? (files.find((file) => file.name === active) ?? null) : null;
  const conflictName = active && params.agentFileConflict === active ? active : null;
  const showMissing = activeEntry?.missing && !conflictName;
  const hasContent = active ? hasAgentFileContent(params, active) : false;
  const editor = active ? params.agentFileEditors[active] : undefined;
  const hasBase = Boolean(editor && Object.hasOwn(editor, "content"));
  const baseContent = editor?.content ?? "";
  const draft = editor?.draft ?? baseContent;
  const isDirty = hasContent && (!hasBase || draft !== baseContent);

  return html`
    ${renderAgentFileError({
      error: params.agentFilesError,
      conflictName,
      busy: params.agentFilesLoading || params.agentFileSaving,
      canWrite: params.canWrite,
      onReload: params.onFileReload,
      onOverwrite: params.onFileOverwrite,
    })}
    ${renderSettingsSection(
      {
        title: t("agents.files.coreFilesTitle"),
        description: list
          ? html`${t("agents.files.coreFilesSubtitle")} ${t("agents.files.workspace")}:
              <code>${list.workspace}</code>`
          : t("agents.files.coreFilesSubtitle"),
        actions: html`
          ${renderAgentPanelAction(params.agentFilesLoading ? t("common.loading") : t("common.refresh"), params.agentFilesLoading, () => params.onLoadFiles(params.agentId))}
        `,
      },
      !list
        ? renderSettingsEmpty(t("agents.files.loadHint"))
        : files.length === 0
          ? renderSettingsEmpty(t("agents.files.empty"))
          : html`
              <div class="agents-panel-body">
                <div class="agent-file-tabs">
                  ${renderHubTabs({
                    id: "agent-files",
                    active,
                    tabs: tabFiles.map((file) => ({
                      value: file.name,
                      label: file.name.replace(/\.md$/i, ""),
                      badge:
                        file.missing && file.expectedAbsent !== true && file.name !== conflictName
                          ? t("agents.files.missing")
                          : undefined,
                      // File reads are serialized; changing the active tab mid-read would
                      // expose an editor whose content request was never accepted.
                      disabled: params.agentFilesLoading,
                    })),
                    ariaLabel: t("agents.files.coreFilesTitle"),
                    panelId: "agent-file-panel",
                    variant: "sub",
                    onSelect: params.onSelectFile,
                  })}
                  ${
                    creatableFiles.length === 0
                      ? nothing
                      : html`
                          <select
                            class="agent-tab-add"
                            aria-label=${t("agents.files.addFile")}
                            .value=${""}
                            ?disabled=${params.agentFilesLoading}
                            @change=${(e: Event) => {
                              const select = e.currentTarget;
                              if (!(select instanceof HTMLSelectElement)) {
                                return;
                              }
                              const name = select.value;
                              select.value = "";
                              if (name) {
                                params.onSelectFile(name);
                              }
                            }}
                          >
                            <option value="">${t("agents.files.addFile")}</option>
                            ${creatableFiles.map(
                              (file) =>
                                html`<option value=${file.name}>
                                  ${file.name.replace(/\.md$/i, "")}
                                </option>`,
                            )}
                          </select>
                        `
                  }
                </div>
                <div
                  id="agent-file-panel"
                  role="tabpanel"
                  aria-labelledby=${active ? `agent-files-tab-${active}` : nothing}
                >
                  ${
                    !activeEntry
                      ? html`<div class="muted">${t("agents.files.selectFile")}</div>`
                      : html`
                          <div class="agent-file-header">
                            <div>
                              <div class="agent-file-sub mono">${activeEntry.path}</div>
                            </div>
                            <div class="agent-file-actions">
                              <button
                                class="btn btn--sm"
                                ?disabled=${!hasContent}
                                @click=${(e: Event) => {
                                  const btn = e.currentTarget;
                                  if (!(btn instanceof HTMLElement)) {
                                    return;
                                  }
                                  btn
                                    .closest(".settings-group")
                                    ?.querySelector<OpenClawModalDialog>("openclaw-modal-dialog")
                                    ?.show();
                                }}
                              >
                                ${icons.eye} ${t("agents.files.preview")}
                              </button>
                              ${renderAgentPanelAction(t("common.reset"), !params.canWrite || !hasBase || !isDirty, () => params.onFileReset(activeEntry.name))}
                              <button
                                class="btn btn--sm primary"
                                ?disabled=${!params.canWrite || !hasContent || params.agentFileSaving || !isDirty}
                                @click=${() => params.onFileSave(activeEntry.name)}
                              >
                                ${params.agentFileSaving ? t("common.saving") : t("common.save")}
                              </button>
                            </div>
                          </div>
                          ${
                            showMissing
                              ? html`<div class="callout info">
                                  ${
                                    activeEntry.expectedAbsent === true
                                      ? t("agents.files.createHint")
                                      : t("agents.files.missingHint")
                                  }
                                </div>`
                              : nothing
                          }
                          <label class="field agent-file-field">
                            <span>${t("agents.files.content")}</span>
                            <textarea
                              class="agent-file-textarea"
                              ?disabled=${!params.canWrite || !hasContent}
                              placeholder=${
                                hasContent
                                  ? nothing
                                  : params.agentFilesLoading
                                    ? t("common.loading")
                                    : t("agents.files.loadHint")
                              }
                              .value=${draft}
                              @input=${(e: Event) => {
                                if (e.currentTarget instanceof HTMLTextAreaElement) {
                                  params.onFileDraftChange(activeEntry.name, e.currentTarget.value);
                                }
                              }}
                            ></textarea>
                          </label>
                          <openclaw-modal-dialog
                            class="agent-file-preview"
                            manual
                            label=${activeEntry.name}
                            style="--openclaw-modal-width: min(1040px, calc(100vw - 32px));"
                            @modal-cancel=${(e: Event) => {
                              if (e.currentTarget instanceof HTMLElement) {
                                resetAgentFilePreview(e.currentTarget);
                              }
                            }}
                          >
                            ${agentFilePreview(
                              [params.agentId, activeEntry.name, hasContent],
                              () => {
                                const previewHtml = toSanitizedMarkdownHtml(draft, {
                                  codeBlockChrome: "none",
                                  mode: "document",
                                });
                                const draftByteSize = formatBytes(
                                  new TextEncoder().encode(draft).length,
                                );
                                const trimmedDraft = draft.trim();
                                const draftWordCount = trimmedDraft
                                  ? trimmedDraft.split(/\s+/).length
                                  : 0;
                                const draftLineCount =
                                  draft.length === 0 ? 0 : draft.split(/\r?\n/).length;
                                const readingTimeLabel =
                                  draftWordCount <= 0
                                    ? t("agents.files.emptyDraft")
                                    : t("agents.files.minRead", {
                                        count: String(
                                          Math.max(1, Math.round(draftWordCount / 220)),
                                        ),
                                      });
                                const activePathLabel = formatWorkspaceRelativePath(
                                  activeEntry.path,
                                  list?.workspace,
                                );
                                const previewTitleId = `agent-file-preview-title-${toDomId(activeEntry.name)}`;
                                const [previewStatusLabel, previewStatusClass] = showMissing
                                  ? [t("agents.files.willCreateOnSave"), "is-missing"]
                                  : isDirty || conflictName
                                    ? [t("agents.files.liveDraftPreview"), "is-dirty"]
                                    : [t("agents.files.savedPreview"), "is-synced"];
                                const previewUpdatedLabel = activeEntry?.updatedAtMs
                                  ? t("agents.files.updated", {
                                      time: formatRelativeTimestamp(activeEntry.updatedAtMs),
                                    })
                                  : showMissing
                                    ? t("agents.files.notCreatedYet")
                                    : t("agents.files.updatedUnknown");
                                return html`<div class="md-preview-dialog__panel">
                                  <div class="md-preview-dialog__header">
                                    <div class="md-preview-dialog__header-main">
                                      <div class="md-preview-dialog__eyebrow">
                                        ${icons.scrollText}
                                        <span>${getExtensionLabel(activeEntry.name)}</span>
                                      </div>
                                      <div class="md-preview-dialog__title-wrap">
                                        <div
                                          id=${previewTitleId}
                                          class="md-preview-dialog__title"
                                          translate="no"
                                        >
                                          ${activeEntry.name}
                                        </div>
                                        <div class="md-preview-dialog__path mono" translate="no">
                                          ${activePathLabel}
                                        </div>
                                      </div>
                                    </div>
                                    <div class="md-preview-dialog__actions">
                                      <openclaw-tooltip .content=${t("agents.files.expandPreview")}>
                                        <button
                                          type="button"
                                          class="btn btn--sm md-preview-icon-btn md-preview-expand-btn"
                                          aria-label=${t("agents.files.expandPreview")}
                                          aria-pressed="false"
                                          @click=${(e: Event) => {
                                            const btn = e.currentTarget;
                                            if (!(btn instanceof HTMLElement)) {
                                              return;
                                            }
                                            const panel = btn.closest(".md-preview-dialog__panel");
                                            if (!panel) {
                                              return;
                                            }
                                            const isFullscreen =
                                              panel.classList.toggle("fullscreen");
                                            btn
                                              .closest("openclaw-modal-dialog")
                                              ?.classList.toggle("fullscreen", isFullscreen);
                                            setPreviewExpandButtonState(btn, isFullscreen);
                                          }}
                                        >
                                          <span class="when-normal" aria-hidden="true"
                                            >${icons.maximize}</span
                                          ><span class="when-fullscreen" aria-hidden="true"
                                            >${icons.minimize}</span
                                          >
                                        </button>
                                      </openclaw-tooltip>
                                      ${(
                                        [
                                          ["editFile", icons.edit, true],
                                          ["closePreview", icons.x, false],
                                        ] as const
                                      ).map(
                                        ([label, icon, focusEditor]) => html`
                                          <openclaw-tooltip .content=${t(`agents.files.${label}`)}>
                                            <button
                                              type="button"
                                              class="btn btn--sm md-preview-icon-btn"
                                              aria-label=${t(`agents.files.${label}`)}
                                              @click=${(event: Event) => closeAgentFilePreview(event, focusEditor)}
                                            >
                                              <span aria-hidden="true">${icon}</span>
                                            </button>
                                          </openclaw-tooltip>
                                        `,
                                      )}
                                    </div>
                                  </div>
                                  <div class="md-preview-dialog__meta">
                                    <div
                                      class="md-preview-dialog__chip ${previewStatusClass}"
                                      data-priority="essential"
                                    >
                                      <strong>${previewStatusLabel}</strong>
                                    </div>
                                    ${renderPreviewFact(readingTimeLabel, t("agents.files.words", { count: String(draftWordCount) }))}
                                    ${renderPreviewFact(draftLineCount, t("agents.files.lines"), true)}
                                    ${renderPreviewFact(draftByteSize, previewUpdatedLabel)}
                                  </div>
                                  <div class="md-preview-dialog__body">
                                    <article class="md-preview-dialog__reader sidebar-markdown">
                                      ${unsafeHTML(previewHtml)}
                                    </article>
                                  </div>
                                </div> `;
                              },
                            )}
                          </openclaw-modal-dialog>
                        `
                  }
                </div>
              </div>
            `,
    )}
  `;
}
