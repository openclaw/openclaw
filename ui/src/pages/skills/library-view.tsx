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
import type { SkillLibraryController } from "./library-controller.ts";
import { libraryEventControl } from "./library-events.ts";
import { libraryFileText } from "./library-files.ts";
import { SkillLibraryToolbar } from "./library-toolbar.tsx";

export function SkillLibrary(props: {
  library: SkillLibraryController;
  navigationActions: JSX.Element;
}) {
  const entries = createMemo(() => {
    const library = props.library;
    const list = library.list;
    const query = library.query.toLowerCase().trim();
    return (list?.entries ?? []).filter((entry) => {
      const scopeMatches =
        library.view === "mine"
          ? entry.ownerProfileId === list?.profileId
          : library.view !== "team" || entry.shared || entry.ownerProfileId === null;
      return (
        scopeMatches &&
        (!query ||
          `${entry.slug} ${entry.name} ${entry.description} ${entry.ownerLabel}`
            .toLowerCase()
            .includes(query))
      );
    });
  });
  return (
    <>
      <SkillLibraryToolbar library={props.library} navigationActions={props.navigationActions} />
      <Show when={props.library.list?.defaultTarget === "unavailable"}>
        <p class="muted">{t("skillLibrary.signIn")}</p>
      </Show>
      <SkillLibraryFeedback library={props.library} />
      <Show when={props.library.list && !props.library.showWorkspace}>
        <p class="muted">
          {t("skillLibrary.defaultLimit", {
            count: String(props.library.list!.defaultSelectionLimit),
          })}
        </p>
        <Show when={props.library.list?.defaultSelectionNotice}>
          <p class="callout" role="status">
            {props.library.list?.defaultSelectionNotice}
          </p>
        </Show>
      </Show>
      <Show when={!props.library.showWorkspace}>
        <label class="field">
          <span>{t("common.search")}</span>
          <input
            class="settings-input"
            name="library-search"
            value={props.library.query}
            placeholder={t("skillLibrary.search")}
            onInput={(event: Event) => {
              props.library.query = libraryEventControl(event, HTMLInputElement).value;
              props.library.changed();
            }}
          />
        </label>
        <Show when={!props.library.loading} fallback={<p role="status">{t("common.loading")}</p>}>
          <SettingsSection title={t(`skillLibrary.${props.library.view}`)} count={entries().length}>
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
                      disabled={props.library.loading || props.library.busy}
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

function LibraryFeedback(props: { error: string | null; notice?: string | null }) {
  return (
    <>
      <Show when={props.error}>
        <div class="callout danger" role="alert">
          {props.error}
        </div>
      </Show>
      <Show when={props.notice}>
        <div class="callout success" role="status">
          {props.notice}
        </div>
      </Show>
    </>
  );
}

export function SkillLibraryFeedback(props: { library: SkillLibraryController }) {
  return (
    <LibraryFeedback
      error={!props.library.draft && !props.library.importOpen ? props.library.error : null}
      notice={!props.library.draft ? props.library.notice : null}
    />
  );
}

export function SkillLibraryDialogs(props: { library: SkillLibraryController }) {
  return (
    <>
      <Show when={props.library.draft}>
        <LibraryEditor library={props.library} />
      </Show>
      <Show when={props.library.importOpen}>
        <LibraryImport library={props.library} />
      </Show>
    </>
  );
}

function LibraryDialog(props: {
  library: SkillLibraryController;
  children: JSX.Element;
  editor?: { title: string; disabled: boolean };
}) {
  return (
    <openclaw-modal-dialog
      label={props.editor?.title ?? t("skillLibrary.import")}
      style={props.editor ? { "--openclaw-modal-width": "960px" } : undefined}
      onModal-cancel={(event: Event) => {
        // Native dismissal must not bypass the controller's busy and discard checks.
        event.preventDefault();
        props.library.close();
      }}
    >
      <form
        class="exec-approval-card skill-reader-dialog"
        onSubmit={(event: SubmitEvent) => {
          event.preventDefault();
          const source = props.library.importSource;
          if (props.editor) {
            void props.library.save();
          } else if (source) {
            void props.library.importClawHub(props.library.importSlug, source.slug, source.version);
          } else {
            void props.library.importFiles(props.library.importSelection);
          }
        }}
        onKeyDown={(event: KeyboardEvent) => {
          if (
            props.editor &&
            (event.ctrlKey || event.metaKey) &&
            event.key === "Enter" &&
            !props.editor.disabled
          ) {
            event.preventDefault();
            libraryEventControl(event, HTMLFormElement).requestSubmit();
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
            disabled={props.library.busy}
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
      </form>
    </openclaw-modal-dialog>
  );
}

function LibraryEditor(props: { library: SkillLibraryController }) {
  const draft = () => props.library.draft!;
  const disabled = () => !props.library.canEdit || props.library.busy || props.library.loading;
  const support = () => draft().files.find((file) => file.path === draft().selectedFile);
  const text = () =>
    draft().selectedFile === "SKILL.md"
      ? draft().content
      : support()
        ? libraryFileText(support()!)
        : null;
  const mutationLocked = () => disabled() || draft().dirty;
  const changeText = (value: string) => {
    if (disabled()) {
      return;
    }
    const current = draft();
    if (current.selectedFile === "SKILL.md") {
      current.content = value;
    } else {
      current.files = current.files.map((file) =>
        file.path === current.selectedFile ? { ...file, content: value, encoding: "utf8" } : file,
      );
    }
    current.dirty = true;
    props.library.changed();
  };
  const MutationButton = (button: {
    action: SkillsLibraryMutateParams["action"];
    locked?: boolean;
  }) => (
    <button
      type="button"
      class={button.action === "remove" ? "btn danger" : "btn"}
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
      <Show when={!props.library.canEdit}>
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
          onInput={(event: Event) => {
            draft().slug = libraryEventControl(event, HTMLInputElement).value;
            draft().dirty = true;
            props.library.changed();
          }}
        />
      </label>
      <div class="plugins-toolbar">
        <label class="field" style={{ "min-width": "0", flex: "1" }}>
          <span>{t("skillLibrary.file")}</span>
          <select
            class="settings-select"
            aria-label={t("skillLibrary.file")}
            value={draft().selectedFile}
            onChange={(event: Event) => {
              draft().selectedFile = libraryEventControl(event, HTMLSelectElement).value;
              props.library.changed();
            }}
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
        <Show when={support() && props.library.canEdit}>
          <button
            type="button"
            class="btn"
            disabled={disabled()}
            onClick={() => {
              const path = support()!.path;
              if (!window.confirm(t("skillLibrary.deleteFileConfirm", { path }))) {
                return;
              }
              draft().files = draft().files.filter((file) => file.path !== path);
              draft().selectedFile = "SKILL.md";
              draft().dirty = true;
              props.library.changed();
            }}
          >
            {t("skillLibrary.deleteFile")}
          </button>
        </Show>
      </div>
      <Show when={support() && props.library.canEdit}>
        <label class="field checkbox">
          <input
            type="checkbox"
            name="library-file-executable"
            disabled={disabled()}
            checked={support()!.executable === true}
            onChange={(event: Event) => {
              const executable = libraryEventControl(event, HTMLInputElement).checked;
              const path = support()!.path;
              draft().files = draft().files.map((file) =>
                file.path === path ? Object.assign({}, file, { executable }) : file,
              );
              draft().dirty = true;
              props.library.changed();
            }}
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
            onInput={(event: Event) =>
              changeText(libraryEventControl(event, HTMLTextAreaElement).value)
            }
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
              value={props.library.newFilePath}
              onInput={(event: Event) => {
                props.library.newFilePath = libraryEventControl(event, HTMLInputElement).value;
                props.library.changed();
              }}
            />
          </label>
          <button
            type="button"
            class="btn"
            disabled={!props.library.newFilePath.trim()}
            onClick={() => {
              const path = props.library.newFilePath.trim();
              if (path === "SKILL.md" || draft().files.some((file) => file.path === path)) {
                props.library.error = t("skillLibrary.fileExists");
              } else {
                draft().files = [...draft().files, { path, content: "", encoding: "utf8" }];
                draft().selectedFile = path;
                draft().dirty = true;
                props.library.newFilePath = "";
              }
              props.library.changed();
            }}
          >
            {t("skillLibrary.addFile")}
          </button>
        </div>
      </Show>
      <LibraryFeedback error={props.library.error} notice={props.library.notice} />
      <div class="plugins-toolbar">
        <Show when={props.library.canEdit}>
          <button
            type="submit"
            class="btn primary"
            disabled={
              disabled() ||
              Boolean(draft().importedFiles && !props.library.uploadsEnabled) ||
              !draft().dirty ||
              !draft().content.trim()
            }
          >
            {props.library.busy ? t("common.loading") : t("skillLibrary.save")}
          </button>
        </Show>
        <Show when={props.library.canEdit && draft().entry}>
          <MutationButton action={draft().entry!.enabled ? "disable" : "enable"} />
          <Show when={draft().entry?.ownerProfileId}>
            <MutationButton action={draft().entry!.shared ? "unshare" : "share"} />
          </Show>
        </Show>
      </div>
      <Show when={props.library.canEdit && draft().entry && draft().revisions.length > 1}>
        <div class="plugins-toolbar">
          <label class="field" style={{ flex: "1", "min-width": "0" }}>
            <span>{t("skillLibrary.revision")}</span>
            <select
              class="settings-select"
              aria-label={t("skillLibrary.revision")}
              value={draft().rollbackRevision}
              disabled={mutationLocked()}
              onChange={(event: Event) => {
                draft().rollbackRevision = libraryEventControl(event, HTMLSelectElement).value;
                props.library.changed();
              }}
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
      <Show when={props.library.canEdit && draft().entry}>
        <div
          class="plugins-toolbar"
          style={{ "border-top": "1px solid var(--border)", "padding-top": "var(--space-4)" }}
        >
          <Show when={props.library.canTransfer && draft().entry?.ownerProfileId}>
            <MutationButton action="transfer" />
          </Show>
          <MutationButton action="remove" />
        </div>
      </Show>
    </LibraryDialog>
  );
}

function LibraryImport(props: { library: SkillLibraryController }) {
  const selectionLabel = () => {
    const selectedFiles = props.library.importSelection;
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
    <LibraryDialog library={props.library}>
      <Show when={!props.library.importSource && !props.library.uploadsEnabled}>
        <p role="status">{uploadsDisabledMessage()}</p>
      </Show>
      <p class="muted">
        {props.library.importSource
          ? t("skillLibrary.importClawHub", { source: props.library.importSource.slug })
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
          value={props.library.importSlug}
          disabled={props.library.busy}
          onInput={(event: Event) => {
            props.library.importSlug = libraryEventControl(event, HTMLInputElement).value;
            props.library.changed();
          }}
        />
      </label>
      <Show when={!props.library.importSource && props.library.uploadsEnabled}>
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
                    disabled={props.library.busy}
                    onClick={(event: Event) => {
                      if (!props.library.uploadsEnabled) {
                        return;
                      }
                      const input = libraryEventControl(
                        event,
                        HTMLButtonElement,
                      ).nextElementSibling;
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
                    disabled={props.library.busy}
                    onChange={(event: Event) => {
                      const input = libraryEventControl(event, HTMLInputElement);
                      props.library.importSelection = props.library.uploadsEnabled
                        ? Array.from(input.files ?? [])
                        : [];
                      input.value = "";
                      props.library.changed();
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
            <Show when={props.library.importSelection.length > 0}>
              <button
                type="button"
                class="btn btn--sm btn--ghost"
                disabled={props.library.busy}
                onClick={() => {
                  props.library.importSelection = [];
                  props.library.changed();
                }}
              >
                {t("skillLibrary.clearSelection")}
              </button>
            </Show>
          </div>
        </div>
      </Show>
      <LibraryFeedback error={props.library.error} />
      <button
        type="submit"
        class="btn primary"
        disabled={
          props.library.busy ||
          (!props.library.importSource &&
            (!props.library.uploadsEnabled || props.library.importSelection.length === 0))
        }
      >
        {props.library.busy ? t("common.loading") : t("skillLibrary.import")}
      </button>
    </LibraryDialog>
  );
}
