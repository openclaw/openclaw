import { createMemo, For, Show } from "solid-js";
import type { AgentFileEntry } from "../../api/types.ts";
import { renderHubTabs } from "../../components/hub-tabs.ts";
import type { OpenClawModalDialog } from "../../components/modal-dialog.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { MarkdownHtml } from "../../components/solid/markdown-html.tsx";
import "../../components/modal-dialog.ts";
import { SettingsEmpty, SettingsSection } from "../../components/solid/settings-ui.tsx";
import "../../components/tooltip.ts";
import { formatBytes } from "../../lib/agents/display.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { pathDisplayName } from "../../lib/path-display.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { LitContent } from "../../lit/solid-bridge.ts";
import { resetAgentFilePreview, setPreviewExpandButtonState } from "./agent-file-preview-state.ts";
import { AgentFilePreview } from "./agent-file-preview.tsx";
import { AgentFileError } from "./file-conflict-callout.tsx";
import { hasAgentFileContent, type AgentFilesViewState } from "./files.ts";
import { AgentPanelAction } from "./panel-ui.tsx";

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
  return (
    <div class="md-preview-dialog__chip" data-priority={secondary ? "secondary" : "essential"}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
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

export function AgentFiles(
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
  const list = createMemo(
    () => (params.agentFilesList?.agentId === params.agentId ? params.agentFilesList : null),
    { equals: false },
  );
  const files = createMemo(() => list()?.files ?? [], { equals: false });
  const active = createMemo(() => params.agentFileActive ?? null);
  // Files whose absence is a normal workspace state stay out of the tab strip until
  // the operator picks them; only a genuinely faulty absence is badged as missing.
  const isCreatable = (file: AgentFileEntry) =>
    file.missing && file.expectedAbsent === true && file.name !== active();
  const tabFiles = createMemo(() => files().filter((file) => !isCreatable(file)));
  const creatableFiles = createMemo(() => files().filter(isCreatable));
  const activeEntry = createMemo(
    () => (active() ? (files().find((file) => file.name === active()) ?? null) : null),
    { equals: false },
  );
  const conflictName = createMemo(() =>
    active() && params.agentFileConflict === active() ? active() : null,
  );
  const showMissing = createMemo(() => activeEntry()?.missing && !conflictName());
  const hasContent = createMemo(() => {
    const name = active();
    return name ? hasAgentFileContent(params, name) : false;
  });
  const editor = createMemo(
    () => {
      const name = active();
      return name ? params.agentFileEditors[name] : undefined;
    },
    { equals: false },
  );
  const hasBase = createMemo(() => {
    const value = editor();
    return Boolean(value && Object.hasOwn(value, "content"));
  });
  const baseContent = createMemo(() => editor()?.content ?? "");
  const draft = createMemo(() => editor()?.draft ?? baseContent());
  const isDirty = createMemo(() => hasContent() && (!hasBase() || draft() !== baseContent()));

  return (
    <>
      <AgentFileError
        error={params.agentFilesError}
        conflictName={conflictName()}
        busy={params.agentFilesLoading || params.agentFileSaving}
        canWrite={params.canWrite}
        onReload={params.onFileReload}
        onOverwrite={params.onFileOverwrite}
      />
      <SettingsSection
        title={t("agents.files.coreFilesTitle")}
        description={
          list() ? (
            <>
              {t("agents.files.coreFilesSubtitle")} {t("agents.files.workspace")}:
              <code>{list()?.workspace}</code>
            </>
          ) : (
            t("agents.files.coreFilesSubtitle")
          )
        }
        actions={
          <AgentPanelAction
            label={params.agentFilesLoading ? t("common.loading") : t("common.refresh")}
            disabled={params.agentFilesLoading}
            onClick={() => params.onLoadFiles(params.agentId)}
          />
        }
      >
        {!list() ? (
          <SettingsEmpty message={t("agents.files.loadHint")} />
        ) : files().length === 0 ? (
          <SettingsEmpty message={t("agents.files.empty")} />
        ) : (
          <div class="agents-panel-body">
            <div class="agent-file-tabs">
              <LitContent
                render={() =>
                  renderHubTabs({
                    id: "agent-files",
                    active: active(),
                    tabs: tabFiles().map((file) => ({
                      value: file.name,
                      label: file.name.replace(/\.md$/i, ""),
                      badge:
                        file.missing && file.expectedAbsent !== true && file.name !== conflictName()
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
                  })
                }
              />
              {creatableFiles().length === 0 ? undefined : (
                <select
                  class="agent-tab-add"
                  aria-label={t("agents.files.addFile")}
                  value={""}
                  disabled={params.agentFilesLoading}
                  onChange={(e: Event) => {
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
                  <option value="">{t("agents.files.addFile")}</option>
                  <For each={creatableFiles()} keyed={(file) => file.name}>
                    {(file) => (
                      <option value={file().name}>{file().name.replace(/\.md$/i, "")}</option>
                    )}
                  </For>
                </select>
              )}
            </div>
            <div
              id="agent-file-panel"
              role="tabpanel"
              aria-labelledby={active() ? `agent-files-tab-${active()}` : undefined}
            >
              <Show
                when={activeEntry()}
                fallback={<div class="muted">{t("agents.files.selectFile")}</div>}
              >
                {(entry) => (
                  <>
                    <div class="agent-file-header">
                      <div>
                        <div class="agent-file-sub mono">{entry().path}</div>
                      </div>
                      <div class="agent-file-actions">
                        <button
                          class="btn btn--sm"
                          disabled={!hasContent()}
                          onClick={(e: Event) => {
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
                          <Icon name="eye" /> {t("agents.files.preview")}
                        </button>
                        <AgentPanelAction
                          label={t("common.reset")}
                          disabled={!params.canWrite || !hasBase() || !isDirty()}
                          onClick={() => params.onFileReset(entry().name)}
                        />
                        <button
                          class="btn btn--sm primary"
                          disabled={
                            !params.canWrite ||
                            !hasContent() ||
                            params.agentFileSaving ||
                            !isDirty()
                          }
                          onClick={() => params.onFileSave(entry().name)}
                        >
                          {params.agentFileSaving ? t("common.saving") : t("common.save")}
                        </button>
                      </div>
                    </div>
                    {showMissing() ? (
                      <div class="callout info">
                        {entry().expectedAbsent === true
                          ? t("agents.files.createHint")
                          : t("agents.files.missingHint")}
                      </div>
                    ) : undefined}
                    <label class="field agent-file-field">
                      <span>{t("agents.files.content")}</span>
                      <textarea
                        class="agent-file-textarea"
                        disabled={!params.canWrite || !hasContent()}
                        placeholder={
                          hasContent()
                            ? undefined
                            : params.agentFilesLoading
                              ? t("common.loading")
                              : t("agents.files.loadHint")
                        }
                        value={draft()}
                        onInput={(e: Event) => {
                          if (e.currentTarget instanceof HTMLTextAreaElement) {
                            params.onFileDraftChange(entry().name, e.currentTarget.value);
                          }
                        }}
                      />
                    </label>
                    <openclaw-modal-dialog
                      class="agent-file-preview"
                      manual
                      label={entry().name}
                      style={{ "--openclaw-modal-width": "min(1040px, calc(100vw - 32px))" }}
                      onModal-cancel={(e: Event) => {
                        if (e.currentTarget instanceof HTMLElement) {
                          resetAgentFilePreview(e.currentTarget);
                        }
                      }}
                    >
                      <AgentFilePreview
                        scope={[params.agentId, entry().name, hasContent()]}
                        snapshot={() => {
                          const markdown = draft();
                          const draftByteSize = formatBytes(
                            new TextEncoder().encode(draft()).length,
                          );
                          const trimmedDraft = draft().trim();
                          const draftWordCount = trimmedDraft
                            ? trimmedDraft.split(/\s+/).length
                            : 0;
                          const draftLineCount =
                            draft().length === 0 ? 0 : draft().split(/\r?\n/).length;
                          const readingTimeLabel =
                            draftWordCount <= 0
                              ? t("agents.files.emptyDraft")
                              : t("agents.files.minRead", {
                                  count: String(Math.max(1, Math.round(draftWordCount / 220))),
                                });
                          const activePathLabel = formatWorkspaceRelativePath(
                            entry().path,
                            list()?.workspace,
                          );
                          const previewTitleId = `agent-file-preview-title-${toDomId(entry().name)}`;
                          const [previewStatusLabel, previewStatusClass] = showMissing()
                            ? [t("agents.files.willCreateOnSave"), "is-missing"]
                            : isDirty() || conflictName()
                              ? [t("agents.files.liveDraftPreview"), "is-dirty"]
                              : [t("agents.files.savedPreview"), "is-synced"];
                          const previewUpdatedLabel = entry()?.updatedAtMs
                            ? t("agents.files.updated", {
                                time: formatRelativeTimestamp(entry().updatedAtMs),
                              })
                            : showMissing()
                              ? t("agents.files.notCreatedYet")
                              : t("agents.files.updatedUnknown");
                          return {
                            markdown,
                            draftByteSize,
                            draftWordCount,
                            draftLineCount,
                            readingTimeLabel,
                            activePathLabel,
                            previewTitleId,
                            previewStatusLabel,
                            previewStatusClass,
                            previewUpdatedLabel,
                            activeName: entry().name,
                          };
                        }}
                      >
                        {(preview) => (
                          <div class="md-preview-dialog__panel">
                            <div class="md-preview-dialog__header">
                              <div class="md-preview-dialog__header-main">
                                <div class="md-preview-dialog__eyebrow">
                                  <Icon name="scrollText" />
                                  <span>{getExtensionLabel(preview().activeName)}</span>
                                </div>
                                <div class="md-preview-dialog__title-wrap">
                                  <div
                                    id={preview().previewTitleId}
                                    class="md-preview-dialog__title"
                                    translate="no"
                                  >
                                    {preview().activeName}
                                  </div>
                                  <div class="md-preview-dialog__path mono" translate="no">
                                    {preview().activePathLabel}
                                  </div>
                                </div>
                              </div>
                              <div class="md-preview-dialog__actions">
                                <openclaw-tooltip prop:content={t("agents.files.expandPreview")}>
                                  <button
                                    type="button"
                                    class="btn btn--sm md-preview-icon-btn md-preview-expand-btn"
                                    aria-label={t("agents.files.expandPreview")}
                                    aria-pressed="false"
                                    onClick={(e: Event) => {
                                      const btn = e.currentTarget;
                                      if (!(btn instanceof HTMLElement)) {
                                        return;
                                      }
                                      const panel = btn.closest(".md-preview-dialog__panel");
                                      if (!panel) {
                                        return;
                                      }
                                      const isFullscreen = panel.classList.toggle("fullscreen");
                                      btn
                                        .closest("openclaw-modal-dialog")
                                        ?.classList.toggle("fullscreen", isFullscreen);
                                      setPreviewExpandButtonState(btn, isFullscreen);
                                    }}
                                  >
                                    <span class="when-normal" aria-hidden="true">
                                      <Icon name="maximize" />
                                    </span>
                                    <span class="when-fullscreen" aria-hidden="true">
                                      <Icon name="minimize" />
                                    </span>
                                  </button>
                                </openclaw-tooltip>
                                <For
                                  each={
                                    [
                                      ["editFile", "edit", true],
                                      ["closePreview", "x", false],
                                    ] as const
                                  }
                                >
                                  {([label, icon, focusEditor]) => (
                                    <openclaw-tooltip prop:content={t(`agents.files.${label}`)}>
                                      <button
                                        type="button"
                                        class="btn btn--sm md-preview-icon-btn"
                                        aria-label={t(`agents.files.${label}`)}
                                        onClick={(event: Event) =>
                                          closeAgentFilePreview(event, focusEditor)
                                        }
                                      >
                                        <span aria-hidden="true">
                                          <Icon name={icon} />
                                        </span>
                                      </button>
                                    </openclaw-tooltip>
                                  )}
                                </For>
                              </div>
                            </div>
                            <div class="md-preview-dialog__meta">
                              <div
                                class={`md-preview-dialog__chip ${preview().previewStatusClass}`}
                                data-priority="essential"
                              >
                                <strong>{preview().previewStatusLabel}</strong>
                              </div>
                              {renderPreviewFact(
                                preview().readingTimeLabel,
                                t("agents.files.words", {
                                  count: String(preview().draftWordCount),
                                }),
                              )}
                              {renderPreviewFact(
                                preview().draftLineCount,
                                t("agents.files.lines"),
                                true,
                              )}
                              {renderPreviewFact(
                                preview().draftByteSize,
                                preview().previewUpdatedLabel,
                              )}
                            </div>
                            <div class="md-preview-dialog__body">
                              <MarkdownHtml
                                as="article"
                                class="md-preview-dialog__reader sidebar-markdown"
                                markdown={preview().markdown}
                                options={{ codeBlockChrome: "none", mode: "document" }}
                              />
                            </div>
                          </div>
                        )}
                      </AgentFilePreview>
                    </openclaw-modal-dialog>
                  </>
                )}
              </Show>
            </div>
          </div>
        )}
      </SettingsSection>
    </>
  );
}
