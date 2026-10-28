import type { JSX } from "@solidjs/web";
import { createMemo, Show } from "solid-js";
import { SettingsSegmented } from "../../components/solid/settings-ui.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import type { SkillLibraryModel, LibraryView } from "./library-state.ts";

export function SkillLibraryToolbar(props: {
  library: SkillLibraryModel;
  navigationActions: JSX.Element;
}) {
  const current = () => props.library.state;
  const busy = () => props.library.saving() || current().busy;
  const listSnapshot = createMemo(() => current().list);
  const options = createMemo(() => {
    const list = listSnapshot();
    const entries: Array<{ value: LibraryView; label: string }> = [];
    if (list?.multipleProfiles || list?.entries.length || list?.defaultTarget === "personal") {
      if (list?.profileId) {
        entries.push({ value: "mine", label: t("skillLibrary.mine") });
      }
      if (
        list?.multipleProfiles ||
        list?.entries.some((entry) => entry.shared || entry.ownerProfileId === null)
      ) {
        entries.push({ value: "team", label: t("skillLibrary.team") });
      }
      entries.push(
        { value: "all", label: t("skillLibrary.all") },
        { value: "workspace", label: t("skillLibrary.inventory") },
      );
    }
    return entries;
  });
  return (
    <>
      <div class="plugins-toolbar">
        {props.navigationActions}
        <button
          type="button"
          class="btn"
          disabled={busy() || !props.library.canCreate()}
          onClick={() => props.library.create()}
        >
          {t("skillLibrary.create")}
        </button>
        <Show when={props.library.uploadsEnabled()}>
          <button
            type="button"
            class="btn"
            disabled={busy() || !props.library.canCreate()}
            onClick={() => {
              if (props.library.uploadsEnabled()) {
                props.library.edit((state) => {
                  state.importSource = null;
                });
                props.library.setImportOpen(true);
              }
            }}
          >
            {t("skillLibrary.import")}
          </button>
        </Show>
      </div>
      <Show when={options().length > 0 || !props.library.showWorkspace()}>
        <div class="plugins-toolbar">
          <Show when={options().length > 0}>
            <SettingsSegmented
              value={current().view ?? "workspace"}
              ariaLabel={t("skillLibrary.library")}
              options={options()}
              onChange={(view) =>
                props.library.edit((state) => {
                  state.view = view;
                })
              }
            />
          </Show>
          <Show when={!props.library.showWorkspace()}>
            <button
              type="button"
              class="btn"
              disabled={busy() || current().loading}
              onClick={() => void props.library.load()}
            >
              {t("common.refresh")}
            </button>
          </Show>
        </div>
      </Show>
    </>
  );
}
