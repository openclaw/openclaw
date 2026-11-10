import type { JSX } from "@solidjs/web";
import { createMemo, For, Show } from "solid-js";
import type { SkillsLibraryMutateParams } from "../../../../packages/gateway-protocol/src/index.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import "../../components/modal-dialog.tsx";
import { Checkbox } from "../../components/solid/checkbox.tsx";
import { SettingsDisclosure } from "../../components/solid/settings-disclosure.tsx";
import { SettingsSelect } from "../../components/solid/settings-select.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { uploadsDisabledMessage } from "../../lib/uploads.ts";
import { LibraryDialog } from "./library-dialog.tsx";
import { libraryFileText } from "./library-file-text.ts";
import type { SkillLibraryModel } from "./library-state.ts";

export function LibraryEditor(props: { library: SkillLibraryModel; feedback: JSX.Element }) {
  const current = () => props.library.state;
  const draft = () => current().draft!;
  const entry = () => props.library.entry();
  const busy = () => props.library.saving() || current().busy;
  const disabled = () => busy() || !props.library.canEdit() || current().loading;
  const support = () => draft().files.find((file) => file.path === draft().selectedFile);
  const deleteSelectedFile = async () => {
    const active = draft();
    const path = active.selectedFile;
    const confirmed = await showConfirmDialog({
      title: t("skillLibrary.deleteFileConfirm", { path }),
      message: t("skillLibrary.deleteFileBody"),
      confirmLabel: t("common.remove"),
      danger: true,
    });
    if (!confirmed || draft() !== active) {
      return;
    }
    props.library.edit((state) => {
      state.draft!.files = state.draft!.files.filter((file) => file.path !== path);
      state.draft!.selectedFile = "SKILL.md";
      state.draft!.dirty = true;
    });
  };
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
      editor={{ title: entry()?.slug ?? t("skillLibrary.create"), disabled: disabled() }}
      footer={
        <Show when={props.library.canEdit()}>
          <openclaw-modal-actions class="oc-dialog__footer">
            <Show when={entry()}>
              <MutationButton action="remove" />
              <MutationButton action={entry()!.enabled ? "disable" : "enable"} />
              <Show when={entry()?.ownerProfileId}>
                <MutationButton action={entry()!.shared ? "unshare" : "share"} />
              </Show>
              <Show when={props.library.canTransfer() && entry()?.ownerProfileId}>
                <MutationButton action="transfer" />
              </Show>
            </Show>
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
              {busy() ? (
                <>
                  <span class="btn__spinner" aria-hidden="true" />
                  {t("common.saving")}
                </>
              ) : (
                t("skillLibrary.save")
              )}
            </button>
          </openclaw-modal-actions>
        </Show>
      }
    >
      <p class="muted">
        {entry()
          ? t("skillLibrary.ownerRevision", {
              owner: entry()!.ownerLabel,
              revision: entry()!.revision.slice(0, 8),
            })
          : t("skillLibrary.personalTarget")}
      </p>
      <Show when={entry()}>
        <SettingsDisclosure
          quiet
          class="skill-library-details"
          title={t("skillLibrary.technicalDetails")}
        >
          <dl>
            <dt>{t("skillLibrary.skillId")}</dt>
            <dd>{entry()!.skillId}</dd>
            <dt>{t("skillLibrary.revision")}</dt>
            <dd>{entry()!.revision}</dd>
            <dt>{t("skillLibrary.command")}</dt>
            <dd>{entry()!.name}</dd>
          </dl>
        </SettingsDisclosure>
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
          <SettingsSelect
            aria-label={t("skillLibrary.file")}
            value={draft().selectedFile}
            onChange={(event) =>
              props.library.edit((state) => {
                state.draft!.selectedFile = event.currentTarget.value;
              })
            }
            options={[
              { value: "SKILL.md", label: "SKILL.md" },
              ...draft().files.map((file) => ({
                value: file.path,
                label: `${file.path}${file.executable ? " *" : ""}`,
              })),
            ]}
          />
        </label>
        <Show when={support() && props.library.canEdit()}>
          <button
            type="button"
            class="btn"
            disabled={disabled()}
            onClick={() => void deleteSelectedFile()}
          >
            {t("skillLibrary.deleteFile")}
          </button>
        </Show>
      </div>
      <Show when={support() && props.library.canEdit()}>
        <label class="field checkbox">
          <Checkbox
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
      <Show when={props.library.canEdit()}>
        <div class="plugins-toolbar">
          <label class="field" style={{ flex: "1", "min-width": "0" }}>
            <span>{t("skillLibrary.newFile")}</span>
            <input
              class="settings-input"
              name="library-file-path"
              disabled={disabled()}
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
            disabled={disabled() || !props.library.local.newFilePath.trim()}
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
      {props.feedback}

      <Show when={props.library.canEdit() && entry() && draft().revisions.length > 1}>
        <div class="plugins-toolbar">
          <label class="field" style={{ flex: "1", "min-width": "0" }}>
            <span>{t("skillLibrary.revision")}</span>
            <SettingsSelect
              aria-label={t("skillLibrary.revision")}
              value={draft().rollbackRevision}
              disabled={mutationLocked()}
              onChange={(event) =>
                props.library.edit((state) => {
                  state.draft!.rollbackRevision = event.currentTarget.value;
                })
              }
              options={[
                { value: "", label: t("skillLibrary.selectRevision") },
                ...draft()
                  .revisions.filter((revision) => revision.revision !== entry()?.revision)
                  .map((revision) => ({
                    value: revision.revision,
                    label: `${new Date(revision.createdAt).toLocaleString()} · ${revision.revision.slice(0, 8)}`,
                  })),
              ]}
            />
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

export function LibraryImport(props: { library: SkillLibraryModel; feedback: JSX.Element }) {
  const current = () => props.library.state;
  const busy = () => props.library.saving() || current().busy;
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
        <openclaw-modal-actions class="oc-dialog__footer">
          <button
            type="submit"
            class="btn primary"
            disabled={
              busy() ||
              !props.library.canWrite() ||
              (!current().importSource &&
                (!props.library.uploadsEnabled() || current().importSelection.length === 0))
            }
          >
            {busy() ? (
              <>
                <span class="btn__spinner" aria-hidden="true" />
                {t("common.importing")}
              </>
            ) : (
              t("skillLibrary.import")
            )}
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
          disabled={busy()}
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
                    disabled={busy()}
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
                    disabled={busy()}
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
                disabled={busy()}
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
      {props.feedback}
    </LibraryDialog>
  );
}
