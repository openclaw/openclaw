import { For } from "solid-js";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { registerSkillLibraryEnglish } from "../../../i18n/locales/en-skill-library.ts";
import { registerSkillsBrowserEnglish } from "../../../i18n/locales/en-skills-browser.ts";
import type { ComposerLibraryProps } from "../composer-library-session.ts";
import { LitContent } from "./chat-composer-interop.tsx";
import {
  menuDivider,
  renderBackRow,
  renderCapabilityMenuState,
} from "./chat-composer-menu-rows.tsx";

registerSkillsBrowserEnglish();
registerSkillLibraryEnglish();

function renderLibraryStatus(library: ComposerLibraryProps) {
  return (
    <>
      {library.loading || library.busy
        ? renderCapabilityMenuState(t("common.loading"), "status")
        : null}
      {library.error ? (
        <>
          {renderCapabilityMenuState(library.error, "alert")}
          <wa-dropdown-item value="library-reload">{t("common.retry")}</wa-dropdown-item>
        </>
      ) : null}
      {library.notice ? renderCapabilityMenuState(library.notice, "status") : null}
    </>
  );
}

export function renderComposerLibraryMenuSolid(library?: ComposerLibraryProps, skillId?: string) {
  if (!library) {
    return null;
  }
  const busy = library.busy || library.loading;
  const session = library.result?.session;
  if (skillId) {
    const pin = session?.selections.find((entry) => entry.skillId === skillId);
    return (
      <>
        {renderBackRow()} {renderLibraryStatus(library)}
        {pin ? (
          <>
            <div class="agent-chat__capability-menu-state">
              <span class="agent-chat__capability-menu-label">
                <strong>
                  {pin.slug} · {pin.ownerLabel}
                </strong>
                <span class="agent-chat__capability-menu-note">
                  {t("skillLibrary.session.pin", { revision: pin.revision.slice(0, 8) })}
                </span>
              </span>
            </div>
            <For keyed={(item) => item} each={["read", "refresh", "detach"] as const}>
              {(menuItem) => (
                <>
                  {menuItem() === "read" || library.canWrite ? (
                    <wa-dropdown-item
                      class="agent-chat__capability-menu-item"
                      value={`library-${menuItem()}:${pin.skillId}`}
                      disabled={busy}
                    >
                      {t(`skillLibrary.session.${menuItem()}`)}
                    </wa-dropdown-item>
                  ) : null}
                </>
              )}
            </For>
          </>
        ) : library.result && !busy ? (
          renderCapabilityMenuState(t("skillsPage.notFound"))
        ) : null}
      </>
    );
  }
  if (
    library.result?.defaultTarget === "workspace" &&
    !session?.selections.length &&
    !session?.attachable.length
  ) {
    return null;
  }
  return (
    <>
      {renderCapabilityMenuState(t("skillLibrary.session.selected"))} {renderLibraryStatus(library)}
      <For keyed={(item) => item} each={session?.selections}>
        {(menuItem) => (
          <wa-dropdown-item
            class="agent-chat__capability-menu-item"
            value={`library-selected:${menuItem().skillId}`}
            disabled={busy}
            title={`${menuItem().slug} · ${menuItem().ownerLabel}`}
          >
            <span class="agent-chat__capability-menu-label">
              <span>
                {menuItem().slug} · {menuItem().ownerLabel}
              </span>
              <span class="agent-chat__capability-menu-note">
                {t("skillLibrary.session.pin", { revision: menuItem().revision.slice(0, 8) })}
              </span>
            </span>
            <span slot="details" class="agent-chat__capability-menu-chevron" aria-hidden="true">
              <LitContent value={icons.chevronRight} />
            </span>
          </wa-dropdown-item>
        )}
      </For>
      {session && session.selections.length === 0
        ? renderCapabilityMenuState(t("skillLibrary.session.empty"))
        : null}
      {session?.attachable.length ? (
        <>
          {menuDivider()} {renderCapabilityMenuState(t("skillLibrary.session.attachable"))}
          <For keyed={(item) => item} each={session.attachable}>
            {(menuItem) => (
              <wa-dropdown-item
                class="agent-chat__capability-menu-item"
                value={`library-attach:${menuItem().skillId}`}
                disabled={busy || !library.canWrite}
              >
                <span class="agent-chat__capability-menu-label">
                  <span title={`${menuItem().slug} · ${menuItem().ownerLabel}`}>
                    {t("skillLibrary.session.attachNamed", {
                      name: menuItem().slug,
                      owner: menuItem().ownerLabel,
                    })}
                  </span>
                  <span class="agent-chat__capability-menu-note" title={menuItem().description}>
                    {menuItem().description}
                  </span>
                </span>
              </wa-dropdown-item>
            )}
          </For>
        </>
      ) : null}
      {library.result
        ? renderCapabilityMenuState(
            t("skillLibrary.defaultLimit", { count: String(library.result.defaultSelectionLimit) }),
          )
        : null}
      {library.result?.defaultSelectionNotice
        ? renderCapabilityMenuState(library.result.defaultSelectionNotice, "status")
        : null}
      {menuDivider()} {renderCapabilityMenuState(t("skillLibrary.inventory"))}
    </>
  );
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
