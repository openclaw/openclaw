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
  const action = (label: string, disabled: boolean, onClick: () => void) => html`<button
    type="button"
    class="btn"
    ?disabled=${disabled}
    @click=${onClick}
  >
    ${t(label)}
  </button>`;
  return html`
    <div class="plugins-toolbar">
      ${navigationActions}
      ${action("skillLibrary.create", !library.canCreate || library.busy, () => library.create())}
      ${
        library.uploadsEnabled
          ? action("skillLibrary.import", !library.canCreate || library.busy, () => {
              if (!library.uploadsEnabled) {
                return;
              }
              library.importOpen = true;
              library.importSource = null;
              library.changed();
            })
          : nothing
      }
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
                ? action(
                    "common.refresh",
                    library.loading || library.busy,
                    () => void library.load(),
                  )
                : nothing
            }
          </div>`
        : nothing
    }
  `;
}
