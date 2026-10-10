import { html, nothing } from "lit";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import type { SessionsProps } from "./view.ts";

export function renderSessionsSearch(
  props: Pick<SessionsProps, "searchQuery" | "sessionMenu" | "onSearchChange">,
) {
  return html`
    <div class="data-table-search sessions-toolbar__search">
      ${icons.search}
      <input
        type="text"
        placeholder=${t("sessionsView.searchPlaceholder")}
        aria-label=${t("sessionsView.searchLabel")}
        .value=${props.searchQuery}
        @input=${(e: Event) => props.onSearchChange((e.target as HTMLInputElement).value)}
        @keydown=${(event: KeyboardEvent) => {
          // SAFETY: This listener is bound directly to the search input.
          const input = event.currentTarget as HTMLInputElement;
          const document = input.ownerDocument;
          if (
            event.key !== "Escape" ||
            event.defaultPrevented ||
            event.isComposing ||
            event.keyCode === 229 ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey ||
            document.activeElement !== input ||
            !input.value ||
            props.sessionMenu ||
            document.openClawModalLayers?.size ||
            document.querySelector(
              "dialog[open], [aria-modal='true'], openclaw-menu-surface, wa-dropdown[open], wa-popover[open], wa-select[open]",
            )
          ) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          props.onSearchChange("");
        }}
      />
      ${
        props.searchQuery.length > 0
          ? html`
              <button
                type="button"
                class="sessions-toolbar__clear"
                aria-label=${t("sessionsView.clearSearch")}
                title=${t("sessionsView.clearSearch")}
                @click=${(event: MouseEvent) => {
                  // SAFETY: This listener is bound directly to the clear button.
                  const input = (event.currentTarget as HTMLElement).parentElement?.querySelector(
                    "input",
                  );
                  input?.focus({ preventScroll: true });
                  props.onSearchChange("");
                }}
              >
                ${icons.x}
              </button>
            `
          : nothing
      }
    </div>
  `;
}
