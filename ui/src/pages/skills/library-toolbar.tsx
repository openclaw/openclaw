import type { JSX } from "@solidjs/web";
import { createMemo, Show } from "solid-js";
import { SettingsSegmented } from "../../components/solid/settings-ui.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import type { SkillLibraryController, LibraryView } from "./library-controller.ts";

export function SkillLibraryToolbar(props: {
  library: SkillLibraryController;
  navigationActions: JSX.Element;
}) {
  const options = createMemo(() => {
    const list = props.library.list;
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
          disabled={!props.library.canCreate || props.library.busy}
          onClick={() => props.library.create()}
        >
          {t("skillLibrary.create")}
        </button>
        <Show when={props.library.uploadsEnabled}>
          <button
            type="button"
            class="btn"
            disabled={!props.library.canCreate || props.library.busy}
            onClick={() => {
              if (!props.library.uploadsEnabled) {
                return;
              }
              props.library.importOpen = true;
              props.library.importSource = null;
              props.library.changed();
            }}
          >
            {t("skillLibrary.import")}
          </button>
        </Show>
      </div>
      <Show when={options().length > 0 || !props.library.showWorkspace}>
        <div class="plugins-toolbar">
          <Show when={options().length > 0}>
            <SettingsSegmented
              value={props.library.view ?? "workspace"}
              ariaLabel={t("skillLibrary.library")}
              options={options()}
              onChange={(view) => {
                props.library.view = view;
                props.library.changed();
              }}
            />
          </Show>
          <Show when={!props.library.showWorkspace}>
            <button
              type="button"
              class="btn"
              disabled={props.library.loading || props.library.busy}
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
