import type { JSX } from "@solidjs/web";
import { createMemo, For, Show } from "solid-js";
import type { SkillsLibraryMutateParams } from "../../../../packages/gateway-protocol/src/index.ts";
import "../../components/modal-dialog.ts";
import { Icon } from "../../components/solid/icon.tsx";
import {
  SettingsEmpty,
  SettingsSection,
  SettingsStatus,
} from "../../components/solid/settings-ui.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { uploadsDisabledMessage } from "../../lib/uploads.ts";
import { libraryFileText } from "./library-file-text.ts";
import type { SkillLibraryModel } from "./library-state.ts";
import { SkillLibraryToolbar } from "./library-toolbar.tsx";

export function SkillLibrary(props: {
  library: SkillLibraryModel;
  navigationActions: JSX.Element;
}) {
  const current = () => props.library.state;
  // List receipts replace the snapshot; mutable editor drafts and feedback do not.
  const list = createMemo(() => current().list);
  const query = createMemo(() => props.library.local.query.toLowerCase().trim());
  const scope = createMemo(() => current().view);
  const entries = createMemo(() => {
    const snapshot = list();
    const search = query();
    const view = scope();
    return (snapshot?.entries ?? []).filter((entry) => {
      const scopeMatches =
        view === "mine"
          ? entry.ownerProfileId === snapshot?.profileId
          : view !== "team" || entry.shared || entry.ownerProfileId === null;
      return (
        scopeMatches &&
        (!search ||
          `${entry.slug} ${entry.name} ${entry.description} ${entry.ownerLabel}`
            .toLowerCase()
            .includes(search))
      );
    });
  });
  return (
    <>
      <SkillLibraryToolbar library={props.library} navigationActions={props.navigationActions} />
      <Show when={current().list?.defaultTarget === "unavailable"}>
        <p class="muted">{t("skillLibrary.signIn")}</p>
      </Show>
      <SkillLibraryFeedback library={props.library} />
      <Show when={current().list && !props.library.showWorkspace()}>
        <p class="muted">
          {t("skillLibrary.defaultLimit", {
            count: String(current().list!.defaultSelectionLimit),
          })}
        </p>
        <Show when={current().list?.defaultSelectionNotice}>
          <p class="callout" role="status">
            {current().list?.defaultSelectionNotice}
          </p>
        </Show>
      </Show>
      <Show when={!props.library.showWorkspace()}>
        <label class="field">
          <span>{t("common.search")}</span>
          <input
            class="settings-input"
            name="library-search"
            value={props.library.local.query}
            placeholder={t("skillLibrary.search")}
            onInput={(event) =>
              props.library.setLocal((state) => {
                state.query = event.currentTarget.value;
              })
            }
          />
        </label>
        <Show when={!current().loading} fallback={<p role="status">{t("common.loading")}</p>}>
          <SettingsSection title={t(`skillLibrary.${current().view}`)} count={entries().length}>
            <Show
              when={entries().length > 0}
              fallback={<SettingsEmpty message={t("skillLibrary.empty")} />}
            >
              <For each={entries()} keyed={(entry) => entry.skillId}>
                {(entry) => (
                  <div class="settings-row">
                    <button
                      type="button"
                      class="settings-row__text plugins-item__detail-button"
                      disabled={current().loading || current().busy}
                      onClick={() => void props.library.open(entry().skillId)}
                    >
                      <span class="settings-row__title">{entry().slug}</span>
                      <span class="settings-row__desc">{entry().description}</span>
                      <span class="settings-row__desc">
                        {entry().ownerLabel} ·{" "}
                        {entry().shared ? t("skillLibrary.shared") : t("skillLibrary.private")} ·{" "}
                        {entry().revision.slice(0, 8)}
                      </span>
                    </button>
                    <div class="settings-row__control">
                      <SettingsStatus
                        kind={entry().enabled ? "ok" : "muted"}
                        label={t(entry().enabled ? "skillsPage.enabled" : "skillsPage.disabled")}
                      />
                    </div>
                  </div>
                )}
              </For>
            </Show>
          </SettingsSection>
        </Show>
      </Show>
      <SkillLibraryDialogs library={props.library} />
    </>
  );
}

export function SkillLibraryFeedback(props: {
  library: SkillLibraryModel;
  dialog?: "editor" | "import";
}) {
  const current = () => props.library.state;
  return (
    <>
      <Show
        when={
          current().error && (props.dialog || (!current().draft && !props.library.local.importOpen))
        }
      >
        <div class="callout danger" role="alert">
          {current().error}
        </div>
      </Show>
      <Show
        when={
          current().notice && (props.dialog === "editor" || (!props.dialog && !current().draft))
        }
      >
        <div class="callout success" role="status">
          {current().notice}
        </div>
      </Show>
    </>
  );
}

export function SkillLibraryDialogs(props: { library: SkillLibraryModel }) {
  const current = () => props.library.state;
  return (
    <>
      <Show when={current().draft}>
        <LibraryEditor library={props.library} />
      </Show>
      <Show when={props.library.local.importOpen}>
        <LibraryImport library={props.library} />
      </Show>
    </>
  );
}

function LibraryDialog(props: {
  library: SkillLibraryModel;
  children: JSX.Element;
  footer: JSX.Element;
  editor?: { title: string; disabled: boolean };
}) {
  const current = () => props.library.state;
  return (
    <openclaw-modal-dialog
      label={props.editor?.title ?? t("skillLibrary.import")}
      style={props.editor ? { "--openclaw-modal-width": "960px" } : undefined}
      onModal-cancel={(event: Event) => {
        // Native dismissal must not bypass the library's busy and discard checks.
        event.preventDefault();
        props.library.close();
      }}
    >
      <form
        class="exec-approval-card skill-reader-dialog"
        onSubmit={(event: SubmitEvent) => {
          event.preventDefault();
          const source = current().importSource;
          if (props.editor) {
            void props.library.save();
          } else if (source) {
            void props.library.importClawHub(current().importSlug, source.slug, source.version);
          } else {
            void props.library.importFiles(current().importSelection);
          }
        }}
        onKeyDown={(event) => {
          if (
            props.editor &&
            (event.ctrlKey || event.metaKey) &&
            event.key === "Enter" &&
            !props.editor.disabled
          ) {
            event.preventDefault();
            event.currentTarget.requestSubmit();
          }
        }}
      >
        <div class="exec-approval-header">
          <strong class="exec-approval-title">
            {props.editor?.title ?? t("skillLibrary.import")}
          </strong>
          <button
            type="button"
            class="btn btn--icon btn--ghost"
            aria-label={t("common.close")}
            disabled={current().busy}
            onClick={() => props.library.close()}
          >
            <Icon name="x" />
          </button>
        </div>
        <div
          class={["skill-reader-dialog__body", { "skill-library-import": !props.editor }]}
          style={
            props.editor ? { display: "grid", gap: "var(--space-4)", "min-width": "0" } : undefined
          }
        >
          {props.children}
        </div>
        {props.footer}
      </form>
    </openclaw-modal-dialog>
  );
}

function LibraryEditor(props: { library: SkillLibraryModel }) {
  const current = () => props.library.state;
  const draft = () => current().draft!;
  const disabled = () => !props.library.canEdit() || current().busy || current().loading;
  const support = () => draft().files.find((file) => file.path === draft().selectedFile);
  const text = createMemo(() =>
    draft().selectedFile === "SKILL.md"
      ? draft().content
      : support()
        ? libraryFileText(support()!)
        : null,
  );
  const mutationLocked = () => disabled() || draft().dirty;
  const changeText = (value: string) => {
    if (disabled()) {
      return;
    }
    props.library.edit((state) => {
      const active = state.draft!;
      if (active.selectedFile === "SKILL.md") {
        active.content = value;
      } else {
        active.files = active.files.map((file) =>
          file.path === active.selectedFile ? { ...file, content: value, encoding: "utf8" } : file,
        );
      }
      active.dirty = true;
    });
  };
  const MutationButton = (button: {
    action: SkillsLibraryMutateParams["action"];
    locked?: boolean;
  }) => (
    <button
      type="button"
      class={["btn", { danger: button.action === "remove" }]}
      disabled={button.locked ?? mutationLocked()}
      onClick={() => void props.library.mutate(button.action)}
    >
      {t(`skillLibrary.${button.action}`)}
    </button>
  );
  return (
    <LibraryDialog
      library={props.library}
      editor={{ title: draft().entry?.slug ?? t("skillLibrary.create"), disabled: disabled() }}
      footer={
        <Show when={props.library.canEdit()}>
          <openclaw-modal-actions class="skill-reader-dialog__actions">
            <button
              type="submit"
              class="btn primary"
              disabled={
                disabled() ||
                Boolean(draft().importedFiles && !props.library.uploadsEnabled()) ||
                !draft().dirty ||
                !draft().content.trim()
              }
            >
              {current().busy ? t("common.loading") : t("skillLibrary.save")}
            </button>
            <Show when={draft().entry}>
              <MutationButton action={draft().entry!.enabled ? "disable" : "enable"} />
              <Show when={draft().entry?.ownerProfileId}>
                <MutationButton action={draft().entry!.shared ? "unshare" : "share"} />
              </Show>
              <Show when={props.library.canTransfer() && draft().entry?.ownerProfileId}>
                <MutationButton action="transfer" />
              </Show>
              <MutationButton action="remove" />
            </Show>
          </openclaw-modal-actions>
        </Show>
      }
    >
      <p class="muted">
        {draft().entry
          ? t("skillLibrary.ownerRevision", {
              owner: draft().entry!.ownerLabel,
              revision: draft().entry!.revision.slice(0, 8),
            })
          : t("skillLibrary.personalTarget")}
      </p>
      <Show when={draft().entry}>
        <details class="muted" style={{ "overflow-wrap": "anywhere", "min-width": "0" }}>
          <summary>{t("skillLibrary.technicalDetails")}</summary>
          <dl>
            <dt>{t("skillLibrary.skillId")}</dt>
            <dd>{draft().entry!.skillId}</dd>
            <dt>{t("skillLibrary.revision")}</dt>
            <dd>{draft().entry!.revision}</dd>
            <dt>{t("skillLibrary.command")}</dt>
            <dd>{draft().entry!.name}</dd>
          </dl>
        </details>
      </Show>
      <Show when={!props.library.canEdit()}>
        <p role="status">{t("skillLibrary.readOnly")}</p>
      </Show>
      <label class="field">
        <span>{t("skillLibrary.slug")}</span>
        <input
          class="settings-input"
          name="library-slug"
          title={t("skillLibrary.slugHelp")}
          required
          pattern="[a-z0-9][a-z0-9\-]{0,62}"
          maxlength={63}
          disabled={disabled()}
          value={draft().slug}
          onInput={(event) =>
            props.library.edit((state) => {
              state.draft!.slug = event.currentTarget.value;
              state.draft!.dirty = true;
            })
          }
        />
      </label>
      <div class="plugins-toolbar">
        <label class="field" style={{ "min-width": "0", flex: "1" }}>
          <span>{t("skillLibrary.file")}</span>
          <select
            class="settings-select"
            aria-label={t("skillLibrary.file")}
            value={draft().selectedFile}
            onChange={(event) =>
              props.library.edit((state) => {
                state.draft!.selectedFile = event.currentTarget.value;
              })
            }
          >
            <option value="SKILL.md" selected={draft().selectedFile === "SKILL.md"}>
              SKILL.md
            </option>
            <For each={draft().files} keyed={(file) => file.path}>
              {(file) => (
                <option value={file().path} selected={draft().selectedFile === file().path}>
                  {file().path}
                  {file().executable ? " *" : ""}
                </option>
              )}
            </For>
          </select>
        </label>
        <Show when={support() && props.library.canEdit()}>
          <button
            type="button"
            class="btn"
            disabled={disabled()}
            onClick={() =>
              props.library.edit((state) => {
                const path = state.draft!.selectedFile;
                if (!window.confirm(t("skillLibrary.deleteFileConfirm", { path }))) {
                  return;
                }
                state.draft!.files = state.draft!.files.filter((file) => file.path !== path);
                state.draft!.selectedFile = "SKILL.md";
                state.draft!.dirty = true;
              })
            }
          >
            {t("skillLibrary.deleteFile")}
          </button>
        </Show>
      </div>
      <Show when={support() && props.library.canEdit()}>
        <label class="field checkbox">
          <input
            type="checkbox"
            name="library-file-executable"
            disabled={disabled()}
            checked={support()!.executable === true}
            onChange={(event) =>
              props.library.edit((state) => {
                const executable = event.currentTarget.checked;
                const path = state.draft!.selectedFile;
                state.draft!.files = state.draft!.files.map((file) =>
                  file.path === path ? Object.assign({}, file, { executable }) : file,
                );
                state.draft!.dirty = true;
              })
            }
          />
          <span>{t("skillLibrary.executable")}</span>
        </label>
      </Show>
      <Show when={text() !== null} fallback={<p class="muted">{t("skillLibrary.binary")}</p>}>
        <label class="field">
          <span>{draft().selectedFile}</span>
          <textarea
            name="library-content"
            class="settings-input"
            spellcheck="false"
            rows={18}
            style={{
              "font-family": "var(--mono)",
              "min-width": "0",
              "max-width": "100%",
              "box-sizing": "border-box",
              resize: "vertical",
            }}
            readonly={disabled()}
            value={text()!}
            onInput={(event) => changeText(event.currentTarget.value)}
          />
        </label>
      </Show>
      <Show when={!disabled()}>
        <div class="plugins-toolbar">
          <label class="field" style={{ flex: "1", "min-width": "0" }}>
            <span>{t("skillLibrary.newFile")}</span>
            <input
              class="settings-input"
              name="library-file-path"
              value={props.library.local.newFilePath}
              onInput={(event) =>
                props.library.setLocal((state) => {
                  state.newFilePath = event.currentTarget.value;
                })
              }
            />
          </label>
          <button
            type="button"
            class="btn"
            disabled={!props.library.local.newFilePath.trim()}
            onClick={() => {
              const path = props.library.local.newFilePath.trim();
              const exists =
                path === "SKILL.md" || draft().files.some((file) => file.path === path);
              props.library.edit((state) => {
                if (exists) {
                  state.error = t("skillLibrary.fileExists");
                } else {
                  const active = state.draft!;
                  active.files = [...active.files, { path, content: "", encoding: "utf8" }];
                  active.selectedFile = path;
                  active.dirty = true;
                }
              });
              if (!exists) {
                props.library.setLocal((local) => {
                  local.newFilePath = "";
                });
              }
            }}
          >
            {t("skillLibrary.addFile")}
          </button>
        </div>
      </Show>
      <SkillLibraryFeedback library={props.library} dialog="editor" />

      <Show when={props.library.canEdit() && draft().entry && draft().revisions.length > 1}>
        <div class="plugins-toolbar">
          <label class="field" style={{ flex: "1", "min-width": "0" }}>
            <span>{t("skillLibrary.revision")}</span>
            <select
              class="settings-select"
              aria-label={t("skillLibrary.revision")}
              value={draft().rollbackRevision}
              disabled={mutationLocked()}
              onChange={(event) =>
                props.library.edit((state) => {
                  state.draft!.rollbackRevision = event.currentTarget.value;
                })
              }
            >
              <option value="" selected={draft().rollbackRevision === ""}>
                {t("skillLibrary.selectRevision")}
              </option>
              <For
                each={draft().revisions.filter(
                  (revision) => revision.revision !== draft().entry?.revision,
                )}
                keyed={(revision) => revision.revision}
              >
                {(revision) => (
                  <option
                    value={revision().revision}
                    selected={draft().rollbackRevision === revision().revision}
                  >
                    {new Date(revision().createdAt).toLocaleString()} ·{" "}
                    {revision().revision.slice(0, 8)}
                  </option>
                )}
              </For>
            </select>
          </label>
          <MutationButton
            action="rollback"
            locked={mutationLocked() || !draft().rollbackRevision}
          />
        </div>
      </Show>
    </LibraryDialog>
  );
}

function LibraryImport(props: { library: SkillLibraryModel }) {
  const current = () => props.library.state;
  const selectionLabel = () => {
    const selectedFiles = current().importSelection;
    return selectedFiles.length
      ? t(selectedFiles.length === 1 ? "skillLibrary.selectedFile" : "skillLibrary.selectedFiles", {
          count: String(selectedFiles.length),
          names:
            selectedFiles
              .slice(0, 2)
              .map((file) => file.webkitRelativePath || file.name)
              .join(", ") + (selectedFiles.length > 2 ? ", …" : ""),
        })
      : t("skillLibrary.noFilesSelected");
  };
  return (
    <LibraryDialog
      library={props.library}
      footer={
        <openclaw-modal-actions class="skill-reader-dialog__actions">
          <button
            type="submit"
            class="btn primary"
            disabled={
              !props.library.canWrite() ||
              current().busy ||
              (!current().importSource &&
                (!props.library.uploadsEnabled() || current().importSelection.length === 0))
            }
          >
            {current().busy ? t("common.loading") : t("skillLibrary.import")}
          </button>
        </openclaw-modal-actions>
      }
    >
      <Show when={!current().importSource && !props.library.uploadsEnabled()}>
        <p role="status">{uploadsDisabledMessage()}</p>
      </Show>
      <p class="muted">
        {current().importSource
          ? t("skillLibrary.importClawHub", { source: current().importSource!.slug })
          : t("skillLibrary.importHelp")}
      </p>
      <label class="field">
        <span>{t("skillLibrary.slug")}</span>
        <input
          class="settings-input"
          required
          name="library-import-slug"
          title={t("skillLibrary.slugHelp")}
          pattern="[a-z0-9][a-z0-9\-]{0,62}"
          value={current().importSlug}
          disabled={current().busy}
          onInput={(event) =>
            props.library.edit((state) => {
              state.importSlug = event.currentTarget.value;
            })
          }
        />
      </label>
      <Show when={!current().importSource && props.library.uploadsEnabled()}>
        <div class="field" role="group" aria-labelledby="library-import-files-label">
          <span id="library-import-files-label">{t("skillLibrary.files")}</span>
          <small id="library-import-files-help" class="settings-row__desc">
            {t("skillLibrary.filesHelp")}
          </small>
          <div class="plugins-toolbar skill-library-import__pickers">
            <For each={[false, true]} keyed={false}>
              {(directory) => (
                <>
                  <button
                    type="button"
                    class="btn"
                    aria-describedby="library-import-files-help library-import-selection"
                    disabled={current().busy}
                    onClick={(event) => {
                      if (!props.library.uploadsEnabled()) {
                        return;
                      }
                      const input = event.currentTarget.nextElementSibling;
                      if (input instanceof HTMLInputElement) {
                        input.click();
                      }
                    }}
                  >
                    {t(
                      directory()
                        ? "skillLibrary.chooseFolderButton"
                        : "skillLibrary.chooseFilesButton",
                    )}
                  </button>
                  <input
                    type="file"
                    hidden
                    webkitdirectory={directory()}
                    multiple
                    name={directory() ? "library-import-directory" : "library-import-files"}
                    disabled={current().busy}
                    onChange={(event) => {
                      const input = event.currentTarget;
                      const files = props.library.uploadsEnabled()
                        ? Array.from(input.files ?? [])
                        : [];
                      props.library.edit((state) => {
                        state.importSelection = files;
                      });
                      input.value = "";
                    }}
                  />
                </>
              )}
            </For>
          </div>
          <div class="plugins-toolbar">
            <small id="library-import-selection" class="settings-row__desc" aria-live="polite">
              {selectionLabel()}
            </small>
            <Show when={current().importSelection.length > 0}>
              <button
                type="button"
                class="btn btn--sm btn--ghost"
                disabled={current().busy}
                onClick={() =>
                  props.library.edit((state) => {
                    state.importSelection = [];
                  })
                }
              >
                {t("skillLibrary.clearSelection")}
              </button>
            </Show>
          </div>
        </div>
      </Show>
      <SkillLibraryFeedback library={props.library} dialog="import" />
    </LibraryDialog>
  );
}
