import type { JSX } from "@solidjs/web";
import {
  action,
  createMemo,
  createOptimistic,
  createSignal,
  Errored,
  For,
  isPending,
  latest,
  Loading,
  onSettled,
  Show,
} from "solid-js";
import type { AgentFileEntry } from "../../api/types.ts";
import type { OpenClawModalDialog } from "../../components/modal-dialog.tsx";
import { HubTabs } from "../../components/solid/hub-tabs.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { MarkdownHtml } from "../../components/solid/markdown-html.tsx";
import { SettingsEmpty, SettingsSection } from "../../components/solid/settings-ui.tsx";
import "../../components/modal-dialog.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import "../../components/tooltip.ts";
import { formatBytes } from "../../lib/agents/display.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { pathDisplayName } from "../../lib/path-display.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { AgentFilePreview } from "./agent-file-preview.tsx";
import type { AgentsPageView } from "./agents-page-state.ts";
import { hasAgentFileContent, isAgentFileDirty, type AgentFileOutcome } from "./files.ts";
import { AgentPanelAction } from "./panel-ui.tsx";
import { AgentReadNotice, createAgentReadPending } from "./read-status.tsx";

registerEnglishCatalog(registerSettingsEnglish);

function AgentFileStatus(props: {
  request: Promise<AgentFileOutcome> | null;
  fallback: (message: string) => JSX.Element;
  children: JSX.Element;
}) {
  return (
    <For each={props.request ? [props.request] : []} fallback={props.children}>
      {(request) => (
        <Errored fallback={(error) => props.fallback(formatUiError(error()))}>
          <Loading>
            <AgentFileCompletion request={request}>{props.children}</AgentFileCompletion>
          </Loading>
        </Errored>
      )}
    </For>
  );
}

function AgentFileCompletion(props: { request: Promise<AgentFileOutcome>; children: JSX.Element }) {
  const completion = createMemo(async () => {
    const outcome = await props.request;
    if (outcome.error !== undefined) {
      throw new Error(outcome.error);
    }
    return null;
  });
  return (
    <>
      {completion()}
      {props.children}
    </>
  );
}

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

export function AgentFiles(
  params: AgentsPageView["agentFiles"] &
    Pick<AgentsPageView, "readData" | "presentationRetired"> & {
      agentId: string;
      canWrite: boolean;
    },
) {
  const inventoryPending = createAgentReadPending(() => params.listRead);
  const contentRequest = createMemo(() => ({ request: params.readData().agentFileRead }), {
    equals: (previous, next) => previous.request === next.request,
  });
  const contentRead = createMemo(() => contentRequest().request ?? undefined, {
    loadingValue: undefined,
  });
  const loading = () =>
    params.readData().agentFilesLoading ||
    inventoryPending() ||
    (params.readData().agentFileRead !== null &&
      (isPending(contentRead) || latest(contentRead) === undefined));
  // The owner admits writes synchronously, including overwrite's preceding hash read.
  const [optimisticSaving, setSaving] = createOptimistic(false);
  const saving = () => optimisticSaving() || params.readData().agentFileSaving;
  const savingAction = action(function* (completion: Promise<boolean>, retired: Promise<void>) {
    setSaving(true);
    yield Promise.race([completion, retired]);
  });
  const save = (name: string, overwrite = false) => {
    const retired = params.presentationRetired();
    const completion = overwrite ? params.onFileOverwrite(name) : params.onFileSave(name);
    if (completion) {
      // Publish the admitted owner state before opening the optimistic transaction.
      onSettled(() => {
        void savingAction(completion, retired);
      });
    }
  };
  const list = () =>
    params.readData().agentFilesList?.agentId === params.agentId
      ? params.readData().agentFilesList
      : null;
  const files = () => list()?.files ?? [];
  const active = createMemo(() => params.readData().agentFileActive ?? null);
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
    active() && params.readData().agentFileConflict === active() ? active() : null,
  );
  const showMissing = () => activeEntry()?.missing && !conflictName();
  const hasContent = createMemo(() => {
    const name = active();
    return name ? hasAgentFileContent(params.readData(), name) : false;
  });
  const editor = () => {
    const name = active();
    return name ? params.readData().agentFileEditors[name] : undefined;
  };
  const hasBase = () => {
    const value = editor();
    return Boolean(value && Object.hasOwn(value, "content"));
  };
  const baseContent = () => editor()?.content ?? "";
  const draft = createMemo(() => editor()?.draft ?? baseContent());
  const isDirty = createMemo(() => isAgentFileDirty(editor()));

  return (
    <>
      <Show
        when={conflictName()}
        fallback={
          <AgentFileStatus
            request={params.readData().agentFileOutcome}
            fallback={(message) => (
              <div class="callout danger" role="alert">
                {message}
              </div>
            )}
          >
            <AgentReadNotice request={params.listRead} />
          </AgentFileStatus>
        }
      >
        {(name) => (
          <div class="callout danger" role="alert">
            <AgentFileStatus
              request={params.readData().agentFileOutcome}
              fallback={(message) => <span>{message}</span>}
            >
              <span>{t("agents.files.conflictHint")}</span>
            </AgentFileStatus>
            <div class="agent-file-actions">
              <button
                class="btn btn--sm"
                type="button"
                disabled={loading() || saving()}
                onClick={() => void params.onFileReload(name())}
              >
                {t("common.reload")}
              </button>
              <button
                class="btn btn--sm"
                type="button"
                disabled={loading() || saving() || !params.canWrite}
                onClick={() => save(name(), true)}
              >
                {t("agents.files.overwrite")}
              </button>
            </div>
          </div>
        )}
      </Show>
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
            label={loading() ? t("common.loading") : t("common.refresh")}
            disabled={loading()}
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
              <HubTabs
                {...{
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
                    disabled: loading(),
                  })),
                  ariaLabel: t("agents.files.coreFilesTitle"),
                  panelId: "agent-file-panel",
                  variant: "sub",
                  onSelect: (name) => void params.onSelectFile(name),
                }}
              />
              {creatableFiles().length === 0 ? undefined : (
                <select
                  class="agent-tab-add"
                  aria-label={t("agents.files.addFile")}
                  value={""}
                  disabled={loading()}
                  onChange={(e) => {
                    const select = e.currentTarget;
                    const name = select.value;
                    select.value = "";
                    if (name) {
                      void params.onSelectFile(name);
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
                {(entry) => {
                  let previewModal: OpenClawModalDialog | undefined;
                  let editorElement: HTMLTextAreaElement | undefined;
                  const [fullscreen, setFullscreen] = createSignal(false);
                  const fullscreenLabel = () =>
                    t(fullscreen() ? "agents.files.collapsePreview" : "agents.files.expandPreview");
                  const closePreview = (focusEditor = false) => {
                    if (focusEditor) {
                      previewModal?.setReturnFocusTarget(editorElement ?? null);
                    }
                    previewModal?.hide();
                    setFullscreen(false);
                  };

                  return (
                    <>
                      <div class="agent-file-header">
                        <div>
                          <div class="agent-file-sub mono">{entry().path}</div>
                        </div>
                        <div class="agent-file-actions">
                          <button
                            class="btn btn--sm"
                            disabled={!hasContent()}
                            onClick={() => previewModal?.show()}
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
                            disabled={!params.canWrite || !hasContent() || saving() || !isDirty()}
                            onClick={() => save(entry().name)}
                          >
                            {saving() ? t("common.saving") : t("common.save")}
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
                          ref={(element) => (editorElement = element)}
                          class="agent-file-textarea"
                          disabled={!params.canWrite || !hasContent()}
                          placeholder={
                            hasContent()
                              ? undefined
                              : loading()
                                ? t("common.loading")
                                : t("agents.files.loadHint")
                          }
                          value={draft()}
                          onInput={(e) =>
                            params.onFileDraftChange(entry().name, e.currentTarget.value)
                          }
                        />
                      </label>
                      <openclaw-modal-dialog
                        ref={(element) => (previewModal = element)}
                        class={["agent-file-preview", { fullscreen: fullscreen() }]}
                        manual
                        label={entry().name}
                        style={{ "--openclaw-modal-width": "min(1040px, calc(100vw - 32px))" }}
                        onModal-cancel={() => setFullscreen(false)}
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
                            <div class={["md-preview-dialog__panel", { fullscreen: fullscreen() }]}>
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
                                  <openclaw-tooltip prop:content={fullscreenLabel()}>
                                    <button
                                      type="button"
                                      class={[
                                        "btn btn--sm md-preview-icon-btn md-preview-expand-btn",
                                        { "is-fullscreen": fullscreen() },
                                      ]}
                                      aria-label={fullscreenLabel()}
                                      aria-pressed={fullscreen() ? "true" : "false"}
                                      onClick={() => setFullscreen((value) => !value)}
                                    >
                                      <span class="when-normal" aria-hidden="true">
                                        <Icon name="maximize" />
                                      </span>
                                      <span class="when-fullscreen" aria-hidden="true">
                                        <Icon name="minimize" />
                                      </span>
                                    </button>
                                  </openclaw-tooltip>
                                  <openclaw-tooltip prop:content={t("agents.files.closePreview")}>
                                    <button
                                      type="button"
                                      class="btn btn--sm md-preview-icon-btn"
                                      aria-label={t("agents.files.closePreview")}
                                      onClick={() => closePreview()}
                                    >
                                      <span aria-hidden="true">
                                        <Icon name="x" />
                                      </span>
                                    </button>
                                  </openclaw-tooltip>
                                </div>
                              </div>
                              <div class="md-preview-dialog__meta">
                                <div
                                  class={["md-preview-dialog__chip", preview().previewStatusClass]}
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
                              <openclaw-modal-actions class="md-preview-dialog__footer">
                                <button
                                  type="button"
                                  class="btn btn--sm"
                                  aria-label={t("agents.files.editFile")}
                                  onClick={() => closePreview(true)}
                                >
                                  <Icon name="edit" /> {t("agents.files.editFile")}
                                </button>
                              </openclaw-modal-actions>
                            </div>
                          )}
                        </AgentFilePreview>
                      </openclaw-modal-dialog>
                    </>
                  );
                }}
              </Show>
            </div>
          </div>
        )}
      </SettingsSection>
    </>
  );
}
