import { html, nothing } from "lit";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { registerSkillLibraryEnglish } from "../../../i18n/locales/en-skill-library.ts";
import { registerSkillsBrowserEnglish } from "../../../i18n/locales/en-skills-browser.ts";
import type { ComposerLibraryProps } from "../composer-library-session.ts";
import { renderBackRow, renderCapabilitySkeletonRows } from "./chat-composer-menu-rows.ts";

registerSkillsBrowserEnglish();
registerSkillLibraryEnglish();

function renderLibraryStatus(library: ComposerLibraryProps, showLoading = true) {
  return html`
    ${
      showLoading && library.loading && !library.result && !library.busy
        ? renderCapabilitySkeletonRows()
        : nothing
    }
    ${
      library.error
        ? html`<div class="agent-chat__capability-menu-state" role="alert">${library.error}</div>
            <wa-dropdown-item value="library-reload">${t("common.retry")}</wa-dropdown-item>`
        : nothing
    }
  `;
}

export function renderComposerLibraryMenu(
  library?: ComposerLibraryProps,
  skillId?: string,
  showLoading = true,
) {
  if (!library) {
    return nothing;
  }
  const busy = library.busy || library.loading;
  const session = library.result?.session;
  if (skillId) {
    const pin = session?.selections.find((entry) => entry.skillId === skillId);
    // Only the viewer's accessible library can establish a newer usable revision.
    const latest = library.result?.entries.find((entry) => entry.skillId === skillId);
    return html`
      ${renderBackRow()} ${renderLibraryStatus(library)}
      ${
        pin
          ? html`
              <div class="agent-chat__capability-menu-state">
                <span class="agent-chat__capability-menu-label">
                  <strong>${pin.slug} · ${pin.ownerLabel}</strong>
                  <span class="agent-chat__capability-menu-note"
                    >${t("skillLibrary.session.pin", { revision: pin.revision.slice(0, 8) })}</span
                  >
                </span>
              </div>
              <wa-dropdown-item
                class="agent-chat__capability-menu-item"
                value=${`library-read:${pin.skillId}`}
                ?disabled=${busy}
                >${t("skillLibrary.session.read")}</wa-dropdown-item
              >
              ${
                library.canWrite
                  ? html`
                      ${
                        latest && latest.revision !== pin.revision
                          ? html`<wa-dropdown-item
                              class="agent-chat__capability-menu-item"
                              value=${`library-refresh:${pin.skillId}`}
                              ?disabled=${busy}
                              >${t("skillLibrary.session.refresh")}</wa-dropdown-item
                            >`
                          : nothing
                      }
                      <wa-dropdown-item
                        class="agent-chat__capability-menu-item"
                        value=${`library-detach:${pin.skillId}`}
                        ?disabled=${busy}
                        >${t("skillLibrary.session.detach")}</wa-dropdown-item
                      >
                    `
                  : nothing
              }
            `
          : library.result && !busy
            ? html`<div class="agent-chat__capability-menu-state">${t("skillsPage.notFound")}</div>`
            : nothing
      }
    `;
  }
  return html`
    ${renderLibraryStatus(library, showLoading)}
    ${session?.selections.map(
      (pin) => html`
        <wa-dropdown-item
          class="agent-chat__capability-menu-item"
          value=${`library-selected:${pin.skillId}`}
          ?disabled=${busy}
          title=${`${pin.slug} · ${pin.ownerLabel}`}
        >
          <span class="agent-chat__capability-menu-label"
            ><span>${pin.slug} · ${pin.ownerLabel}</span></span
          >
          <span slot="details" class="agent-chat__capability-menu-chevron" aria-hidden="true"
            >${icons.chevronRight}</span
          >
        </wa-dropdown-item>
      `,
    )}
  `;
}

export function renderComposerLibraryAddMenu(library?: ComposerLibraryProps) {
  const session = library?.result?.session;
  const full = Boolean(
    library?.result && session && session.selections.length >= library.result.defaultSelectionLimit,
  );
  const busy = !library || library.loading || library.busy;
  return html`
    ${renderBackRow()} ${library ? renderLibraryStatus(library) : nothing}
    ${
      full
        ? html`<div class="agent-chat__capability-menu-state" role="status">
            ${t("skillLibrary.session.full", { count: String(library?.result?.defaultSelectionLimit) })}
          </div>`
        : nothing
    }
    ${session?.attachable.map(
      (entry) => html`
        <wa-dropdown-item
          class="agent-chat__capability-menu-item"
          value=${`library-attach:${entry.skillId}`}
          ?disabled=${busy || !library?.canWrite || full}
        >
          <span class="agent-chat__capability-menu-label">
            <span title=${`${entry.slug} · ${entry.ownerLabel}`}
              >${t("skillLibrary.session.attachNamed", { name: entry.slug, owner: entry.ownerLabel })}</span
            >
            <span class="agent-chat__capability-menu-note" title=${entry.description}
              >${entry.description}</span
            >
          </span>
        </wa-dropdown-item>
      `,
    )}
    ${
      library?.result && !busy && !library.error && !session?.attachable.length
        ? html`<div class="agent-chat__capability-menu-state">
            ${t("skillLibrary.session.noMore")}
          </div>`
        : nothing
    }
  `;
}

export function handleComposerLibrarySelection(
  value: string,
  library: ComposerLibraryProps | undefined,
  changeView: (view: "skills" | "library-add" | `library:${string}`) => void,
): boolean {
  if (!value.startsWith("library-")) {
    return false;
  }
  if (value === "library-reload") {
    library?.onReload();
  } else if (library && !library.loading && !library.busy) {
    const skillId = value.slice(value.indexOf(":") + 1);
    const pin = library.result?.session?.selections.find((entry) => entry.skillId === skillId);
    if (value === "library-add" && library.canWrite) {
      changeView("library-add");
    } else if (value.startsWith("library-selected:") && pin) {
      changeView(`library:${pin.skillId}`);
    } else if (value.startsWith("library-read:") && pin) {
      library.onRead(pin.skillId, pin.revision);
    } else if (library.canWrite) {
      if (value.startsWith("library-attach:")) {
        const session = library.result?.session;
        const attachable = session?.attachable.find((entry) => entry.skillId === skillId);
        if (
          attachable &&
          library.result &&
          session &&
          session.selections.length < library.result.defaultSelectionLimit
        ) {
          library.onActivate("attach", attachable.skillId, attachable.revision);
          changeView("skills");
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
