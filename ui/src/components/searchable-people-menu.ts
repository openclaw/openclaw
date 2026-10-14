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
