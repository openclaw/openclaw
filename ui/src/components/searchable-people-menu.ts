import { html, nothing, type TemplateResult } from "lit";
import { AsyncDirective, directive } from "lit/async-directive.js";
import { live } from "lit/directives/live.js";
import { t } from "../i18n/index.ts";
import { registerSessionPeopleEnglish } from "../i18n/locales/en-session-people.ts";

registerSessionPeopleEnglish();

type PeopleMenuRow = { text: string; render: () => TemplateResult };
const PAGE_SIZE = 20;

/** Keep rows directly slotted: Web Awesome only navigates direct dropdown items. */
class SearchablePeopleMenu extends AsyncDirective {
  private rows: readonly PeopleMenuRow[] = [];
  private scope: unknown;
  private slot?: string;
  private query = "";
  private page = 0;

  render(rows: readonly PeopleMenuRow[], scope: unknown, slot?: string) {
    if (scope !== this.scope) {
      this.query = "";
      this.page = 0;
    }
    this.rows = rows;
    this.scope = scope;
    this.slot = slot;
    return this.content();
  }

  private readonly onInput = (event: Event) => {
    // SAFETY: this listener is bound only to the search input rendered below.
    this.query = (event.currentTarget as HTMLInputElement).value;
    this.page = 0;
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

  private movePage(event: MouseEvent, page: number) {
    event.stopPropagation();
    const button = event.currentTarget;
    this.page = page;
    this.setValue(this.content());
    // Chromium blurs a control disabled by the new page; keep keyboard focus in the editor.
    if (button instanceof HTMLButtonElement && button.disabled) {
      button.parentElement?.parentElement
        ?.querySelector<HTMLInputElement>(":scope > .people-menu__search input")
        ?.focus({ preventScroll: true });
    }
  }

  private content() {
    const terms = this.query.trim().toLocaleLowerCase().split(/\s+/u);
    const matches = this.rows.filter((row) => {
      const text = row.text.toLocaleLowerCase();
      return terms.every((term) => text.includes(term));
    });
    this.page = Math.min(this.page, Math.max(0, Math.ceil(matches.length / PAGE_SIZE) - 1));
    const start = this.page * PAGE_SIZE;
    const visible = matches.slice(start, start + PAGE_SIZE);
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
      ${visible.map((row) => row.render())}
      <div
        slot=${this.slot ?? nothing}
        class="people-menu__pagination"
        @click=${(event: Event) => event.stopPropagation()}
        @keydown=${(event: KeyboardEvent) => {
          if (!handlePeopleMenuKeydown(event) && event.key !== "Escape") {
            event.stopPropagation();
          }
        }}
      >
        <span role="status"
          >${
            matches.length === 0
              ? t("sessionsView.noPeopleMatch")
              : this.rows.length > PAGE_SIZE || this.query
                ? t("sessionsView.peopleRange", {
                    start: String(start + 1),
                    end: String(start + visible.length),
                    total: String(matches.length),
                  })
                : nothing
          }</span
        >
        ${
          matches.length > PAGE_SIZE
            ? html`
                <button
                  type="button"
                  class="btn btn--ghost btn--sm"
                  ?disabled=${this.page === 0}
                  @click=${(event: MouseEvent) => this.movePage(event, this.page - 1)}
                >
                  ${t("common.previous")}
                </button>
                <button
                  type="button"
                  class="btn btn--ghost btn--sm"
                  ?disabled=${start + PAGE_SIZE >= matches.length}
                  @click=${(event: MouseEvent) => this.movePage(event, this.page + 1)}
                >
                  ${t("common.next")}
                </button>
              `
            : nothing
        }
      </div>
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
  const container =
    target?.closest(".people-menu__search, .people-menu__pagination")?.parentElement ??
    item?.parentElement;
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
  const buttons = [
    ...(container?.querySelectorAll<HTMLButtonElement>(
      ":scope > .people-menu__pagination button:not(:disabled)",
    ) ?? []),
  ];
  const controls: HTMLElement[] = [search, ...buttons];
  const index = controls.indexOf(target);
  if (index < 0 && (!item || !rows.includes(item))) {
    return false;
  }
  const sequence = [...controls, ...(rows[0] ? [rows[0]] : [])];
  const current = index < 0 ? sequence.length - 1 : index;
  event.preventDefault();
  event.stopPropagation();
  sequence[(current + (event.shiftKey ? -1 : 1) + sequence.length) % sequence.length]?.focus();
  return true;
}
