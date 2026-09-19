import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type { LibraryDraft, SkillLibraryController } from "./library-controller.ts";
import { libraryEventControl } from "./library-events.ts";

export function renderLibraryFilePath(library: SkillLibraryController, draft: LibraryDraft) {
  return html`<div class="plugins-toolbar">
      <label class="field" style="flex: 1; min-width: 0;"
        ><span>${t("skillLibrary.newFile")}</span
        ><input
          class="settings-input"
          name="library-file-path"
          aria-describedby=${
            draft.target === "workspace" ? "library-workspace-file-path-help" : nothing
          }
          .value=${library.newFilePath}
          @input=${(event: Event) => {
            library.newFilePath = libraryEventControl(event, HTMLInputElement).value;
            library.changed();
          }} /></label
      ><button
        type="button"
        class="btn"
        ?disabled=${!library.newFilePath.trim()}
        @click=${() => {
          const path = library.newFilePath.trim();
          if (path === "SKILL.md" || draft.files.some((file) => file.path === path)) {
            library.error = t("skillLibrary.fileExists");
          } else {
            draft.files = [...draft.files, { path, content: "", encoding: "utf8" }];
            draft.selectedFile = path;
            draft.dirty = true;
            library.newFilePath = "";
          }
          library.changed();
        }}
      >
        ${t("skillLibrary.addFile")}
      </button>
    </div>
    ${
      draft.target === "workspace"
        ? html`<small id="library-workspace-file-path-help" class="settings-row__desc">
            ${t("skillLibrary.workspaceFilePathHelp")}
          </small>`
        : nothing
    } `;
}
