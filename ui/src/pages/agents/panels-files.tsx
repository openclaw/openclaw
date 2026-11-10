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
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { MarkdownHtml } from "../../components/solid/markdown-html.tsx";
import { RefreshButton } from "../../components/solid/refresh-button.tsx";
import "../../components/modal-dialog.tsx";
import { SettingsEmpty, SettingsSection } from "../../components/solid/settings-ui.tsx";
import "../../components/tooltip.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
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

function renderPreviewFact(text: string, secondary = false) {
  return (
    <span class="md-preview-dialog__chip" data-priority={secondary ? "secondary" : "essential"}>
      {text}
    </span>
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
              <InlineAlert tone="danger" role="alert">
                {message}
              </InlineAlert>
            )}
          >
            <AgentReadNotice request={params.listRead} />
          </AgentFileStatus>
        }
      >
        {(name) => (
          <InlineAlert tone="danger" role="alert">
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
          </InlineAlert>
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
          <RefreshButton
            label={t("common.refresh")}
            busy={loading()}
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
                fallback={<SettingsEmpty message={t("agents.files.selectFile")} />}
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
                        <InlineAlert tone="info">
                          {entry().expectedAbsent === true
                            ? t("agents.files.createHint")
                            : t("agents.files.missingHint")}
                        </InlineAlert>
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
                            const previewStatusLabel = showMissing()
                              ? t("agents.files.willCreateOnSave")
                              : isDirty() || conflictName()
                                ? t("agents.files.liveDraftPreview")
                                : t("agents.files.savedPreview");
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
                              previewUpdatedLabel,
                              activeName: entry().name,
                            };
                          }}
                        >
                          {(preview) => (
                            <div
                              class={[
                                "oc-dialog md-preview-dialog__panel",
                                { fullscreen: fullscreen() },
                              ]}
                            >
                              <div class="oc-dialog__header md-preview-dialog__header">
                                <h2
                                  id={preview().previewTitleId}
                                  class="oc-dialog__title md-preview-dialog__title"
                                  translate="no"
                                >
                                  {preview().activeName}
                                </h2>
                                <div class="md-preview-dialog__actions">
                                  <openclaw-tooltip prop:content={fullscreenLabel()}>
                                    <button
                                      type="button"
                                      class={[
                                        "oc-icon-button oc-icon-button--28 oc-dialog__close md-preview-expand-btn",
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
                                      class="oc-icon-button oc-icon-button--28 oc-dialog__close"
                                      aria-label={t("agents.files.closePreview")}
                                      onClick={() => closePreview()}
                                    >
                                      <span aria-hidden="true">
                                        <Icon name="x" />
                                      </span>
                                    </button>
                                  </openclaw-tooltip>
                                </div>
                                {preview().activePathLabel !== preview().activeName ? (
                                  <div
                                    class="oc-dialog__description md-preview-dialog__path mono"
                                    translate="no"
                                  >
                                    {preview().activePathLabel}
                                  </div>
                                ) : null}
                                <div class="md-preview-dialog__meta">
                                  {renderPreviewFact(preview().previewStatusLabel)}
                                  {renderPreviewFact(preview().readingTimeLabel)}
                                  {renderPreviewFact(
                                    t("agents.files.words", {
                                      count: String(preview().draftWordCount),
                                    }),
                                    true,
                                  )}
                                  {renderPreviewFact(
                                    `${preview().draftLineCount} ${t("agents.files.lines")}`,
                                    true,
                                  )}
                                  {renderPreviewFact(preview().draftByteSize)}
                                  {renderPreviewFact(preview().previewUpdatedLabel, true)}
                                </div>
                              </div>
                              <div class="md-preview-dialog__body">
                                <MarkdownHtml
                                  as="article"
                                  class="md-preview-dialog__reader sidebar-markdown"
                                  markdown={preview().markdown}
                                  options={{ codeBlockChrome: "none", mode: "document" }}
                                />
                              </div>
                              <openclaw-modal-actions class="oc-dialog__footer md-preview-dialog__footer">
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
