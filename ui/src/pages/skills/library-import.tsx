import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import { t } from "../../lib/reactive/i18n.ts";
import { uploadsDisabledMessage } from "../../lib/uploads.ts";
import { LibraryDialog } from "./library-dialog.tsx";
import type { SkillLibraryModel } from "./library-state.ts";

export function LibraryImport(props: { library: SkillLibraryModel; children: JSX.Element }) {
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
                (current().importMethod === "github"
                  ? !current().importUrl.trim()
                  : !props.library.uploadsEnabled() || current().importSelection.length === 0))
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
      <Show
        when={
          !current().importSource &&
          current().importMethod === "files" &&
          !props.library.uploadsEnabled()
        }
      >
        <p role="status">{uploadsDisabledMessage()}</p>
      </Show>
      <p class="muted">
        {current().importSource
          ? t("skillLibrary.importClawHub", { source: current().importSource!.slug })
          : current().importMethod === "github"
            ? t("skillLibrary.repositoryHelp")
            : t("skillLibrary.importHelp")}
      </p>
      <Show when={!current().importSource}>
        <div class="plugins-toolbar" role="group" aria-label={t("skillLibrary.importSource")}>
          <For each={["files", "github"] as const}>
            {(method) => (
              <button
                type="button"
                class={["btn btn--sm", { primary: current().importMethod === method }]}
                aria-pressed={current().importMethod === method ? "true" : "false"}
                disabled={busy()}
                onClick={() =>
                  props.library.edit((state) => {
                    state.importMethod = method;
                  })
                }
              >
                {t(method === "files" ? "skillLibrary.uploadFiles" : "skillLibrary.githubUrl")}
              </button>
            )}
          </For>
        </div>
      </Show>
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
      <Show when={!current().importSource && current().importMethod === "github"}>
        <label class="field">
          <span>{t("skillLibrary.repositoryUrl")}</span>
          <input
            class="settings-input"
            type="url"
            required
            placeholder="https://github.com/owner/repo/tree/main/skills/my-skill"
            value={current().importUrl}
            disabled={busy()}
            onInput={(event) =>
              props.library.edit((state) => {
                state.importUrl = event.currentTarget.value;
              })
            }
          />
        </label>
      </Show>
      <Show
        when={
          !current().importSource &&
          current().importMethod === "files" &&
          props.library.uploadsEnabled()
        }
      >
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
      {props.children}
    </LibraryDialog>
  );
}
