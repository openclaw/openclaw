import type { JSX } from "@solidjs/web";
import { createMemo, createUniqueId, Show } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { Menu, type MenuEntry } from "../../components/solid/menu.tsx";
import { RefreshButton } from "../../components/solid/refresh-button.tsx";
import { SettingsSegmented } from "../../components/solid/settings-ui.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import type { SkillLibraryModel, LibraryView } from "./library-state.ts";

type SkillLibraryNavigationProps = {
  onSearch: () => void;
  onWorkshop: () => void;
};

export function SkillLibraryNavigation(props: SkillLibraryNavigationProps) {
  return (
    <>
      <button type="button" class="btn" onClick={() => props.onSearch()}>
        <Icon name="search" />
        {t("skillDiscovery.search")}
      </button>
      <button type="button" class="btn" onClick={() => props.onWorkshop()}>
        {t("pluginsPage.workshopTab")}
      </button>
    </>
  );
}

function openLibraryImport(library: SkillLibraryModel) {
  if (library.uploadsEnabled()) {
    library.edit((state) => {
      state.importSource = null;
    });
    library.setImportOpen(true);
  }
}

// Phone widths swap the toolbar's page actions for this menu; both run the same actions.
export function SkillLibraryPageMenu(
  props: SkillLibraryNavigationProps & {
    library: SkillLibraryModel;
  },
) {
  const id = createUniqueId();
  const locked = () =>
    props.library.saving() || props.library.state.busy || !props.library.canCreate();
  const items = (): MenuEntry[] => [
    { id: "search", label: t("skillDiscovery.search") },
    { id: "workshop", label: t("pluginsPage.workshopTab") },
    { id: "create", label: t("skillLibrary.create"), disabled: locked() },
    ...(props.library.uploadsEnabled()
      ? [{ id: "import", label: t("skillLibrary.import"), disabled: locked() }]
      : []),
  ];
  return (
    <Menu
      id={id}
      lazy
      class="skill-library-search__action"
      label={t("browser.moreActions")}
      placement="bottom-end"
      pointerFocus="trigger"
      triggerClass="btn btn--sm skill-library-search__icon"
      trigger={<Icon name="moreHorizontal" />}
      items={items()}
      onSelect={(item) => {
        if (item.id === "create") {
          props.library.create();
        } else if (item.id === "import") {
          openLibraryImport(props.library);
        } else if (item.id === "search") {
          props.onSearch();
        } else if (item.id === "workshop") {
          props.onWorkshop();
        }
      }}
    />
  );
}

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
      <div class="plugins-toolbar skill-library-toolbar__actions">
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
            onClick={() => openLibraryImport(props.library)}
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
            <RefreshButton
              class="skill-library-toolbar__refresh"
              label={t("common.refresh")}
              busy={current().loading}
              disabled={busy()}
              onClick={() => void props.library.load()}
            />
          </Show>
        </div>
      </Show>
    </>
  );
}
