import { html, nothing, type TemplateResult } from "lit";
import { AsyncDirective, directive } from "lit/async-directive.js";
import { live } from "lit/directives/live.js";
import { t } from "../i18n/index.ts";
import { registerSessionPeopleEnglish } from "../i18n/locales/en-session-people.ts";

registerSessionPeopleEnglish();

type PeopleMenuRow = { text: string; render: () => TemplateResult };

/** Keep rows directly slotted: Web Awesome only navigates direct dropdown items. */
class SearchablePeopleMenu extends AsyncDirective {
  private rows: readonly PeopleMenuRow[] = [];
  private scope: unknown;
  private slot?: string;
  private query = "";

  render(rows: readonly PeopleMenuRow[], scope: unknown, slot?: string) {
    if (scope !== this.scope) {
      this.query = "";
    }
    this.rows = rows;
    this.scope = scope;
    this.slot = slot;
    return this.content();
  }

  private readonly onInput = (event: Event) => {
    // SAFETY: this listener is bound only to the search input rendered below.
    this.query = (event.currentTarget as HTMLInputElement).value;
    this.setValue(this.content());
  };

  private readonly onKeydown = (event: KeyboardEvent) => {
    if (handlePeopleMenuKeydown(event) || event.key === "Escape") {
      return;
    }
    // Editing belongs to the field, not dropdown typeahead or menu shortcuts.
    event.stopPropagation();
    if (event.isComposing || event.keyCode === 229 || !["ArrowDown", "Enter"].includes(event.key)) {
      return;
    }
    event.preventDefault();
    // SAFETY: this key handler is bound only to the rendered search input.
    let item = (event.currentTarget as HTMLElement).parentElement?.nextElementSibling;
    while (item?.localName === "wa-dropdown-item") {
      if (item instanceof HTMLElement && !item.hasAttribute("disabled")) {
        item.focus();
        return;
      }
      item = item.nextElementSibling;
    }
  };

  private content() {
    const terms = this.query.trim().toLocaleLowerCase().split(/\s+/u);
    const matches = this.rows.filter((row) => {
      const text = row.text.toLocaleLowerCase();
      return terms.every((term) => text.includes(term));
    });
    return html`
      <div
        slot=${this.slot ?? nothing}
        class="people-menu__search"
        @click=${(event: Event) => event.stopPropagation()}
      >
        <input
          type="search"
          autocomplete="off"
          aria-label=${t("sessionsView.searchPeople")}
          placeholder=${t("sessionsView.searchPeople")}
          .value=${live(this.query)}
          @input=${this.onInput}
          @keydown=${this.onKeydown}
        />
      </div>
      ${matches.map((row) => row.render())}
      ${
        matches.length === 0
          ? html`<div slot=${this.slot ?? nothing} class="people-menu__status" role="status">
              ${t("sessionsView.noPeopleMatch")}
            </div>`
          : nothing
      }
    `;
  }
}

export const searchablePeopleMenu = directive(SearchablePeopleMenu);

/** Native menu navigation skips plain controls; Tab enters this embedded people editor. */
export function handlePeopleMenuKeydown(event: KeyboardEvent): boolean {
  if (event.key !== "Tab") {
    return false;
  }
  const target = event
    .composedPath()
    .find((item): item is HTMLElement => item instanceof HTMLElement);
  const item = event
    .composedPath()
    .find(
      (entry): entry is HTMLElement =>
        entry instanceof HTMLElement && entry.localName === "wa-dropdown-item",
    );
  const container = target?.closest(".people-menu__search")?.parentElement ?? item?.parentElement;
  const search = container?.querySelector<HTMLInputElement>(":scope > .people-menu__search input");
  if (!search || !target) {
    return false;
  }
  const rows: HTMLElement[] = [];
  for (
    let row = search.parentElement?.nextElementSibling;
    row?.localName === "wa-dropdown-item";
    row = row.nextElementSibling
  ) {
    if (row instanceof HTMLElement && !row.hasAttribute("disabled")) {
      rows.push(row);
    }
  }
  if (target !== search && (!item || !rows.includes(item))) {
    return false;
  }
  event.preventDefault();
  event.stopPropagation();
  (target === search ? (rows[0] ?? search) : search).focus();
  return true;
}
