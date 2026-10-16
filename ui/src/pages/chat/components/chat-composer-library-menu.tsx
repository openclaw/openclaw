import { Icon } from "../../../components/solid/icon.tsx";
import type { MenuEntry } from "../../../components/solid/menu.tsx";
import { registerSkillLibraryEnglish } from "../../../i18n/locales/en-skill-library.ts";
import { registerSkillsBrowserEnglish } from "../../../i18n/locales/en-skills-browser.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import type { ComposerLibraryProps } from "../composer-library-session.ts";
import {
  menuDivider,
  renderBackRow,
  renderCapabilityMenuState,
} from "./chat-composer-menu-rows.tsx";

registerEnglishCatalog(registerSkillsBrowserEnglish);
registerEnglishCatalog(registerSkillLibraryEnglish);

function libraryStatus(library: ComposerLibraryProps): MenuEntry[] {
  const entries: MenuEntry[] = [];
  if (library.loading || library.busy) {
    entries.push(renderCapabilityMenuState("library-loading", t("common.loading"), "status"));
  }
  if (library.error) {
    entries.push(renderCapabilityMenuState("library-error", library.error, "alert"), {
      id: "library-reload",
      label: t("common.retry"),
      closeOnSelect: false,
    });
  }
  if (library.notice) {
    entries.push(renderCapabilityMenuState("library-notice", library.notice, "status"));
  }
  return entries;
}

export function composerLibraryMenuItems(
  library?: ComposerLibraryProps,
  skillId?: string,
): MenuEntry[] {
  if (!library) {
    return [];
  }
  const busy = library.busy || library.loading;
  const session = library.result?.session;
  if (skillId) {
    const entries: MenuEntry[] = [
      renderBackRow(),
      menuDivider("library-back-divider"),
      ...libraryStatus(library),
    ];
    const pin = session?.selections.find((entry) => entry.skillId === skillId);
    if (pin) {
      entries.push(
        renderCapabilityMenuState(
          "library-pin",
          <span class="agent-chat__capability-menu-label">
            <strong>
              {pin.slug} · {pin.ownerLabel}
            </strong>
            <span class="agent-chat__capability-menu-note">
              {t("skillLibrary.session.pin", { revision: pin.revision.slice(0, 8) })}
            </span>
          </span>,
        ),
      );
      for (const action of ["read", "refresh", "detach"] as const) {
        if (action === "read" || library.canWrite) {
          entries.push({
            id: `library-${action}:${pin.skillId}`,
            label: t(`skillLibrary.session.${action}`),
            class: "agent-chat__capability-menu-item",
            disabled: busy,
            closeOnSelect: false,
          });
        }
      }
    } else if (library.result && !busy) {
      entries.push(renderCapabilityMenuState("library-not-found", t("skillsPage.notFound")));
    }
    return entries;
  }
  if (
    library.result?.defaultTarget === "workspace" &&
    !session?.selections.length &&
    !session?.attachable.length
  ) {
    return [];
  }
  const entries: MenuEntry[] = [
    renderCapabilityMenuState("library-selected-heading", t("skillLibrary.session.selected")),
    ...libraryStatus(library),
  ];
  for (const pin of session?.selections ?? []) {
    const label = `${pin.slug} · ${pin.ownerLabel}`;
    entries.push({
      id: `library-selected:${pin.skillId}`,
      label,
      class: "agent-chat__capability-menu-item",
      disabled: busy,
      attributes: { title: label },
      content: (
        <span class="agent-chat__capability-menu-label">
          <span>{label}</span>
          <span class="agent-chat__capability-menu-note">
            {t("skillLibrary.session.pin", { revision: pin.revision.slice(0, 8) })}
          </span>
        </span>
      ),
      details: (
        <span class="agent-chat__capability-menu-chevron" aria-hidden="true">
          <Icon name="chevronRight" />
        </span>
      ),
      closeOnSelect: false,
    });
  }
  if (session && !session.selections.length) {
    entries.push(renderCapabilityMenuState("library-empty", t("skillLibrary.session.empty")));
  }
  if (session?.attachable.length) {
    entries.push(
      menuDivider("library-attach-divider"),
      renderCapabilityMenuState("library-attach-heading", t("skillLibrary.session.attachable")),
    );
    for (const pin of session.attachable) {
      const label = t("skillLibrary.session.attachNamed", {
        name: pin.slug,
        owner: pin.ownerLabel,
      });
      entries.push({
        id: `library-attach:${pin.skillId}`,
        label,
        class: "agent-chat__capability-menu-item",
        disabled: busy || !library.canWrite,
        content: (
          <span class="agent-chat__capability-menu-label">
            <span title={`${pin.slug} · ${pin.ownerLabel}`}>{label}</span>
            <span class="agent-chat__capability-menu-note" title={pin.description}>
              {pin.description}
            </span>
          </span>
        ),
        closeOnSelect: false,
      });
    }
  }
  if (library.result) {
    entries.push(
      renderCapabilityMenuState(
        "library-limit",
        t("skillLibrary.defaultLimit", { count: String(library.result.defaultSelectionLimit) }),
      ),
    );
  }
  if (library.result?.defaultSelectionNotice) {
    entries.push(
      renderCapabilityMenuState(
        "library-selection-notice",
        library.result.defaultSelectionNotice,
        "status",
      ),
    );
  }
  entries.push(
    menuDivider("library-inventory-divider"),
    renderCapabilityMenuState("library-inventory-heading", t("skillLibrary.inventory")),
  );
  return entries;
}

export function handleComposerLibrarySelection(
  value: string,
  library: ComposerLibraryProps | undefined,
  changeView: (view: "skills" | `library:${string}`) => void,
): boolean {
  if (!value.startsWith("library-")) {
    return false;
  }
  if (value === "library-reload") {
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
