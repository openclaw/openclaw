import { Icon } from "../../../components/solid/icon.tsx";
import type { MenuItem } from "../../../components/solid/menu.tsx";
import { registerChatComposerMenuEnglish } from "../../../i18n/locales/en-chat-composer-menu.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import type { ChatComposerPlusMenuView } from "../composer-capability-types.ts";
import type { ComposerLibraryProps } from "../composer-library-session.ts";
import {
  menuChevron,
  menuDivider,
  renderBackRow,
  renderCapabilityMenuState,
  skillIcon,
} from "./chat-composer-menu-rows.tsx";

registerEnglishCatalog(registerChatComposerMenuEnglish);

type LibraryMenuEntry = MenuItem | ReturnType<typeof renderCapabilityMenuState>;

function libraryStatus(library: ComposerLibraryProps): LibraryMenuEntry[] {
  if (library.error) {
    return [
      renderCapabilityMenuState("library-error", library.error, "alert"),
      {
        id: "library-reload",
        label: t("common.retry"),
        class: "agent-chat__capability-menu-item",
        icon: <Icon name="refresh" />,
        closeOnSelect: false,
      },
    ];
  }
  return library.loading
    ? [renderCapabilityMenuState("library-loading", t("common.loading"), "status")]
    : [];
}

export function composerLibraryMenuItems(
  library: ComposerLibraryProps | undefined,
  skillId?: string,
): LibraryMenuEntry[] {
  if (!library) {
    return [];
  }
  const busy = library.busy || library.loading;
  const session = library.result?.session;
  if (skillId) {
    const pin = session?.selections.find((entry) => entry.skillId === skillId);
    const current = library.result?.entries.find((entry) => entry.skillId === skillId);
    const entries: LibraryMenuEntry[] = [
      renderBackRow(pin?.slug ?? t("chat.composer.menu.skills")),
      menuDivider("library-header-divider"),
      ...libraryStatus(library),
    ];
    if (!pin) {
      return entries;
    }
    entries.push(
      renderCapabilityMenuState(
        "library-description",
        <div class="agent-chat__capability-menu-description">
          <span>{t("chat.composer.menu.libraryOwner", { owner: pin.ownerLabel })}</span>
          <p>{pin.description}</p>
        </div>,
      ),
      menuDivider("library-actions-divider"),
      {
        id: `library-read:${pin.skillId}`,
        label: t("chat.composer.menu.readSkill"),
        class: "agent-chat__capability-menu-item",
        icon: <Icon name="book" />,
        details: menuChevron(),
        disabled: busy,
        closeOnSelect: false,
      },
    );
    if (library.canWrite) {
      entries.push(
        {
          id: `library-refresh:${pin.skillId}`,
          label: t("chat.composer.menu.updateSkill"),
          class: "agent-chat__capability-menu-item",
          icon: <Icon name="refresh" />,
          disabled: busy,
          closeOnSelect: false,
          details:
            current && current.revision !== pin.revision ? (
              <span class="agent-chat__capability-menu-accent">
                {t("chat.composer.menu.newVersion")}
              </span>
            ) : undefined,
        },
        menuDivider("library-remove-divider"),
        {
          id: `library-detach:${pin.skillId}`,
          label: t("chat.composer.menu.removeSkill"),
          class: "agent-chat__capability-menu-item",
          icon: <Icon name="x" />,
          variant: "danger",
          disabled: busy,
          closeOnSelect: false,
        },
      );
    }
    return entries;
  }
  return [
    ...libraryStatus(library),
    ...(session?.selections ?? []).map((pin): MenuItem => ({
      id: `library-selected:${pin.skillId}`,
      label: `${pin.slug} ${pin.ownerLabel}`,
      class: "agent-chat__capability-menu-item",
      icon: skillIcon(),
      disabled: busy,
      closeOnSelect: false,
      details: menuChevron(),
      content: (
        <span class="agent-chat__capability-menu-label">
          <span>{pin.slug}</span>
          <span class="agent-chat__capability-menu-note">{pin.ownerLabel}</span>
        </span>
      ),
    })),
    ...(session
      ? [
          {
            id: "library-add",
            label: t("chat.composer.menu.addFromLibraries"),
            class: "agent-chat__capability-menu-item",
            icon: <Icon name="plus" />,
            details: menuChevron(),
            disabled: busy || !library.canWrite,
            closeOnSelect: false,
          } satisfies MenuItem,
        ]
      : []),
  ];
}

export function composerLibraryAddItems(
  library: ComposerLibraryProps | undefined,
): LibraryMenuEntry[] {
  const entries: LibraryMenuEntry[] = [
    renderBackRow(t("chat.composer.menu.addFromLibraries")),
    menuDivider("library-add-header"),
  ];
  if (!library) {
    return entries;
  }
  entries.push(...libraryStatus(library));
  const session = library.result?.session;
  const selected = new Set(session?.selections.map((pin) => pin.skillId));
  const attachable = session?.attachable ?? [];
  const rows = [
    ...attachable,
    ...(library.result?.entries ?? []).filter(
      (entry) =>
        selected.has(entry.skillId) && !attachable.some((pin) => pin.skillId === entry.skillId),
    ),
  ];
  for (const pin of rows) {
    entries.push({
      id: `library-attach:${pin.skillId}`,
      label: pin.name || pin.slug,
      class: "agent-chat__capability-menu-item agent-chat__capability-menu-library-add",
      attributes: { "data-selected": selected.has(pin.skillId) ? "true" : undefined },
      icon: skillIcon(),
      disabled: library.loading || library.busy || !library.canWrite || selected.has(pin.skillId),
      closeOnSelect: false,
      content: (
        <span class="agent-chat__capability-menu-label">
          <span>{pin.name || pin.slug}</span>
          <span class="agent-chat__capability-menu-note">
            {pin.ownerLabel} · {pin.description}
          </span>
        </span>
      ),
      details: (
        <span class={selected.has(pin.skillId) ? "agent-chat__capability-menu-accent" : undefined}>
          <Icon name={selected.has(pin.skillId) ? "check" : "plus"} />
        </span>
      ),
    });
  }
  return entries;
}

export function handleComposerLibrarySelection(
  value: string,
  library: ComposerLibraryProps | undefined,
  changeView: (view: ChatComposerPlusMenuView) => void,
): boolean {
  if (!value.startsWith("library-")) {
    return false;
  }
  if (value === "library-add") {
    changeView("libraries");
  } else if (value === "library-reload") {
    library?.onReload();
  } else if (library && !library.loading && !library.busy) {
    const skillId = value.slice(value.indexOf(":") + 1);
    const pin = library.result?.session?.selections.find((entry) => entry.skillId === skillId);
    if (value.startsWith("library-selected:") && pin) {
      changeView(`library:${pin.skillId}`);
    } else if (value.startsWith("library-read:") && pin) {
      library.onRead(pin.skillId, pin.revision);
    } else if (library.canWrite) {
      if (value.startsWith("library-attach:")) {
        const attachable = library.result?.session?.attachable.find(
          (entry) => entry.skillId === skillId,
        );
        if (attachable) {
          library.onActivate("attach", attachable.skillId, attachable.revision);
        }
      } else if (pin && value.startsWith("library-detach:")) {
        library.onActivate("detach", pin.skillId);
        changeView("skills");
      } else if (pin && value.startsWith("library-refresh:")) {
        library.onActivate("refresh", pin.skillId);
      }
    }
  }
  return true;
}
