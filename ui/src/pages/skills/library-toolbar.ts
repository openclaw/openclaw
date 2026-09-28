import { html, nothing, type TemplateResult } from "lit";
import { renderSettingsSegmented } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import type { SkillLibraryController, LibraryView } from "./library-controller.ts";

export function renderSkillLibraryToolbar(
  library: SkillLibraryController,
  navigationActions: TemplateResult,
) {
  const list = library.list;
  const options: Array<{ value: LibraryView; label: string }> = [];
  if (list?.multipleProfiles || list?.entries.length || list?.defaultTarget === "personal") {
    if (list?.profileId) {
      options.push({ value: "mine", label: t("skillLibrary.mine") });
    }
    if (
      list?.multipleProfiles ||
      list?.entries.some((entry) => entry.shared || entry.ownerProfileId === null)
    ) {
      options.push({ value: "team", label: t("skillLibrary.team") });
    }
    options.push(
      { value: "all", label: t("skillLibrary.all") },
      { value: "workspace", label: t("skillLibrary.inventory") },
    );
  }
  return html`
    <div class="plugins-toolbar">
      ${navigationActions}
      <button
        type="button"
        class="btn"
        ?disabled=${!library.canCreate || library.busy}
        @click=${() => library.create()}
      >
        ${t("skillLibrary.create")}
      </button>
      <button
        type="button"
        class="btn"
        ?disabled=${!library.canCreate || library.busy}
        @click=${() => {
          library.importOpen = true;
          library.importSource = null;
          library.changed();
        }}
      >
        ${t("skillLibrary.import")}
      </button>
    </div>
    ${
      options.length > 0 || !library.showWorkspace
        ? html`<div class="plugins-toolbar">
            ${
              options.length > 0
                ? renderSettingsSegmented({
                    value: library.view ?? "workspace",
                    ariaLabel: t("skillLibrary.library"),
                    options,
                    onChange: (view) => {
                      library.view = view;
                      library.changed();
                    },
                  })
                : nothing
            }
            ${
              !library.showWorkspace
                ? html`<button
                    type="button"
                    class="btn"
                    ?disabled=${library.loading || library.busy}
                    @click=${() => void library.load()}
                  >
                    ${t("common.refresh")}
                  </button>`
                : nothing
            }
          </div>`
        : nothing
    }
  `;
}
