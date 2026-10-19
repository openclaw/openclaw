import { createContext, onCleanup } from "solid-js";
import { registerMenuShortcuts } from "../../../components/menu-shortcuts.ts";
import { generateUUID } from "../../../lib/uuid.ts";

type ModelSearchState = {
  details?: HTMLDetailsElement;
  summary?: HTMLElement;
  inputs: Set<HTMLInputElement>;
  menus: Set<HTMLElement>;
  empty: Set<HTMLElement>;
  rows: Set<HTMLButtonElement>;
  lists: Set<HTMLElement>;
  groups: Set<HTMLButtonElement>;
  more: Set<HTMLButtonElement>;
  shortcuts: Set<HTMLElement>;
  highlighted?: HTMLButtonElement;
  shortcutCleanup?: () => void;
  syncQueued: boolean;
};

const pickers = new WeakMap<HTMLDetailsElement, ModelSearchState>();

/** Each picker owns its rendered nodes, including its lazily mounted panel. */
export function createChatModelSearch() {
  const state: ModelSearchState = {
    inputs: new Set(),
    menus: new Set(),
    empty: new Set(),
    rows: new Set(),
    lists: new Set(),
    groups: new Set(),
    more: new Set(),
    shortcuts: new Set(),
    syncQueued: false,
  };
  onCleanup(() => {
    state.shortcutCleanup?.();
    if (state.details) {
      pickers.delete(state.details);
    }
  });
  return Object.assign(state, {
    detailsRef(element: HTMLDetailsElement) {
      state.details = element;
      pickers.set(element, state);
    },
    summaryRef(this: void, element: HTMLElement) {
      state.summary = element;
    },
    ref<T extends HTMLElement>(nodes: Set<T>) {
      let current: T | undefined;
      onCleanup(() => {
        if (current) {
          nodes.delete(current);
          if (state.highlighted?.isSameNode(current)) {
            highlightModelRow(state, undefined);
          }
          queueModelSearchSync(state);
        }
      });
      return (element: T) => {
        if (current) {
          nodes.delete(current);
        }
        current = element;
        nodes.add(element);
        queueModelSearchSync(state);
      };
    },
  });
}

// Account sections also render on their own, outside a model picker.
export const ChatModelSearchContext = createContext<ReturnType<
  typeof createChatModelSearch
> | null>(null);

function pickerState(target: EventTarget | null): ModelSearchState | undefined {
  const details =
    target instanceof Element
      ? target.closest<HTMLDetailsElement>(".chat-controls__model-picker")
      : null;
  return details ? pickers.get(details) : undefined;
}

function queueModelSearchSync(state: ModelSearchState): void {
  if (state.syncQueued) {
    return;
  }
  state.syncQueued = true;
  queueMicrotask(() => {
    state.syncQueued = false;
    if (state.details?.isConnected && state.details.open) {
      const input = state.inputs.values().next().value;
      if (input) {
        updateModelSearch(input, true);
      }
    }
  });
}

function documentOrder(left: Element, right: Element): number {
  if (left === right) {
    return 0;
  }
  return left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
}

function selectableModelRows(state: ModelSearchState): HTMLButtonElement[] {
  return [...state.rows]
    .filter((row) => !row.hidden && isSelectableModelRow(row))
    .toSorted(
      (left, right) =>
        Number(left.dataset.chatModelRank ?? left.dataset.chatModelIndex ?? 0) -
        Number(right.dataset.chatModelRank ?? right.dataset.chatModelIndex ?? 0),
    );
}

function isSelectableModelRow(row: HTMLButtonElement): boolean {
  return !row.disabled && row.getAttribute("aria-disabled") !== "true";
}

function ensureModelPickerIds(state: ModelSearchState, input: HTMLInputElement): void {
  const details = state.details;
  if (!details) {
    return;
  }
  const prefix = details.dataset.chatModelPickerId ?? `chat-model-picker-${generateUUID()}`;
  details.dataset.chatModelPickerId = prefix;
  const listboxes = [...state.lists].toSorted(documentOrder);
  listboxes.forEach((listbox, index) => {
    listbox.id = `${prefix}-listbox-${index}`;
    const toggles = listbox.hasAttribute("data-chat-model-more") ? state.more : state.groups;
    const section = listbox.closest("section");
    [...toggles]
      .find((toggle) => toggle.closest("section") === section)
      ?.setAttribute("aria-controls", listbox.id);
  });
  input.setAttribute("aria-controls", listboxes.map((listbox) => listbox.id).join(" "));
  input.setAttribute("aria-expanded", details.open ? "true" : "false");
}

function highlightModelRow(state: ModelSearchState, row: HTMLButtonElement | undefined): void {
  if (row && state.highlighted === row) {
    return;
  }
  state.highlighted?.removeAttribute("data-chat-model-highlighted");
  state.highlighted = row;
  row?.setAttribute("data-chat-model-highlighted", "");
  const input = state.inputs.values().next().value;
  if (row) {
    row.id ||= `chat-model-option-${generateUUID()}`;
    input?.setAttribute("aria-activedescendant", row.id);
  } else {
    input?.removeAttribute("aria-activedescendant");
  }
}

export function handleModelOptionMouseEnter(event: MouseEvent): void {
  const row = event.currentTarget;
  const state = pickerState(row);
  if (row instanceof HTMLButtonElement && state) {
    highlightModelRow(state, row);
  }
}

// Numbers follow the filtered order because digit selection reads that same row list.
// Search inputs and nested dropdowns own digits instead. The :focus-within rule
// in styles/chat/composer.css hides these keycaps while the search input has focus.
function updateModelShortcuts(state: ModelSearchState, rows: readonly HTMLButtonElement[]): void {
  state.shortcutCleanup?.();
  const shortcuts: Array<{ element: HTMLElement; key: string }> = [];
  const keycaps = new Map<HTMLButtonElement, HTMLElement>();
  for (const shortcut of state.shortcuts) {
    shortcut.hidden = true;
    shortcut.removeAttribute("data-shortcut");
    shortcut.removeAttribute("data-chat-model-shortcut-number");
    const row = shortcut.closest<HTMLButtonElement>("[data-chat-model-option]");
    if (row) {
      keycaps.set(row, shortcut);
    }
  }
  rows.slice(0, 9).forEach((row, index) => {
    const shortcut = keycaps.get(row);
    if (!shortcut) {
      return;
    }
    shortcut.hidden = false;
    shortcut.setAttribute("data-shortcut", String(index + 1));
    shortcut.setAttribute("data-chat-model-shortcut-number", String(index + 1));
    shortcuts.push({ element: row, key: String(index + 1) });
  });
  state.shortcutCleanup = state.details
    ? registerMenuShortcuts(state.details, () => shortcuts)
    : undefined;
}

function modelMatchRank(row: HTMLButtonElement, query: string): number | null {
  const model = row.dataset.chatModelName ?? "";
  const keywords = row.dataset.chatModelKeywords ?? "";
  const provider = row.dataset.chatModelProviderLabel ?? "";
  if (model.startsWith(query)) {
    return 0;
  }
  if (model.includes(query)) {
    return 1;
  }
  if (keywords.includes(query)) {
    return 2;
  }
  if (provider.startsWith(query)) {
    return 3;
  }
  if (provider.includes(query)) {
    return 4;
  }
  const reference = row.dataset.chatModelTarget ?? row.dataset.chatModelOption ?? "";
  return reference.toLocaleLowerCase().includes(query) ? 5 : null;
}

export function updateModelSearch(input: HTMLInputElement, preserveHighlight = false): void {
  const state = pickerState(input);
  if (!state) {
    return;
  }
  ensureModelPickerIds(state, input);
  const query = input.value.trim().toLocaleLowerCase();
  state.menus.values().next().value?.toggleAttribute("data-chat-model-filtering", Boolean(query));
  const collapsedGroups = new Set(
    [...state.groups]
      .filter((toggle) => toggle.getAttribute("aria-expanded") === "false")
      .map((toggle) => toggle.closest("section")),
  );
  const collapsedMore = new Set(
    [...state.more]
      .filter((toggle) => toggle.getAttribute("aria-expanded") === "false")
      .map((toggle) => toggle.closest("section")),
  );
  // Searching reaches every model; expanding All models is a one-way disclosure.
  for (const toggle of state.more) {
    toggle.hidden =
      Boolean(query) ||
      toggle.getAttribute("aria-expanded") === "true" ||
      collapsedGroups.has(toggle.closest("section"));
  }
  const matches: Array<{ row: HTMLButtonElement; score: number; index: number }> = [];
  [...state.rows].toSorted(documentOrder).forEach((row, index) => {
    const section = row.closest("section");
    const collapsed =
      collapsedGroups.has(section) ||
      (row.closest("[data-chat-model-more]") !== null && collapsedMore.has(section));
    const score = query ? modelMatchRank(row, query) : collapsed ? null : 0;
    row.hidden = score === null;
    if (score !== null) {
      matches.push({ row, score, index });
    }
  });
  // Hidden rows keep an unused rank; visible matches publish their current order below.
  const selectableRows: HTMLButtonElement[] = [];
  matches
    .toSorted((left, right) => left.score - right.score || left.index - right.index)
    .forEach(({ row }, rank) => {
      row.dataset.chatModelRank = String(rank);
      row.style.setProperty("--chat-model-rank", String(rank));
      if (isSelectableModelRow(row)) {
        selectableRows.push(row);
      }
    });
  updateModelShortcuts(state, selectableRows);
  const selected = selectableRows.find((row) => row.getAttribute("aria-selected") === "true");
  const highlighted = preserveHighlight
    ? selectableRows.find((row) => row === state.highlighted)
    : undefined;
  highlightModelRow(
    state,
    highlighted ?? (query ? selectableRows[0] : (selected ?? selectableRows[0])),
  );
  const empty = state.empty.values().next().value;
  if (empty) {
    empty.hidden = !query || matches.length > 0;
  }
}

export function resetModelSearch(details: HTMLDetailsElement): void {
  const input = pickers.get(details)?.inputs.values().next().value;
  if (input) {
    input.value = "";
    updateModelSearch(input);
  }
}

export function toggleModelProviderGroup(event: MouseEvent): void {
  event.stopPropagation();
  // SAFETY: Bound only to provider group and "All models" disclosure buttons.
  const toggle = event.currentTarget as HTMLButtonElement;
  const hadFocus = toggle.ownerDocument.activeElement === toggle;
  toggle.setAttribute("aria-expanded", String(toggle.getAttribute("aria-expanded") !== "true"));
  const state = pickerState(toggle);
  const input = state?.inputs.values().next().value;
  if (input) {
    updateModelSearch(input, true);
  }
  // An expanded "All models" row hides itself; focus its first selectable model.
  if (hadFocus && toggle.hidden) {
    const section = toggle.closest("section");
    const target =
      state &&
      [...state.rows]
        .toSorted(documentOrder)
        .find(
          (row) =>
            row.closest("section") === section &&
            row.closest("[data-chat-model-more]") !== null &&
            !row.hidden &&
            !row.disabled,
        );
    (target ?? input)?.focus({ preventScroll: true });
  }
}

export function clearChatModelSearchOnEscape(event: KeyboardEvent): boolean {
  if (event.key !== "Escape") {
    return false;
  }
  const input = event
    .composedPath()
    .find(
      (target): target is HTMLInputElement =>
        target instanceof HTMLInputElement && target.matches("[data-chat-model-search]"),
    );
  if (!input?.value) {
    return false;
  }
  input.value = "";
  updateModelSearch(input);
  event.preventDefault();
  event.stopPropagation();
  return true;
}

export function handleModelSearchKeydown(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) {
    return;
  }
  if (event.key !== "Enter" && event.key !== "ArrowDown" && event.key !== "ArrowUp") {
    return;
  }
  const state = pickerState(event.currentTarget);
  if (!state) {
    return;
  }
  const rows = selectableModelRows(state);
  if (rows.length === 0) {
    return;
  }
  if (event.key === "Enter") {
    if (state.highlighted && rows.includes(state.highlighted)) {
      event.preventDefault();
      state.highlighted.click();
    }
    return;
  }
  event.preventDefault();
  const currentIndex = rows.findIndex((row) => row === state.highlighted);
  const offset = event.key === "ArrowDown" ? 1 : rows.length - 1;
  const nextIndex = currentIndex < 0 ? 0 : (currentIndex + offset) % rows.length;
  highlightModelRow(state, rows[nextIndex]);
  rows[nextIndex]?.scrollIntoView?.({ block: "nearest" });
}

export function handleModelPickerKeydown(event: KeyboardEvent): void {
  // SAFETY: Bound only to the model picker's details element.
  const details = event.currentTarget as HTMLDetailsElement;
  if (
    event.defaultPrevented ||
    !details.open ||
    event.target instanceof HTMLInputElement ||
    event
      .composedPath()
      .some(
        (target) =>
          target instanceof HTMLElement &&
          target !== details &&
          target.matches('[role="menu"][popover], details[data-chat-native-picker]'),
      ) ||
    !/^[1-9]$/u.test(event.key)
  ) {
    return;
  }
  const state = pickers.get(details);
  const row = state && selectableModelRows(state)[Number(event.key) - 1];
  event.preventDefault();
  row?.click();
}

export function syncChatModelSearch(details: Element | undefined): void {
  if (!(details instanceof HTMLDetailsElement) || !details.open) {
    return;
  }
  const state = pickers.get(details);
  if (!state) {
    return;
  }
  const active = details.ownerDocument.activeElement;
  const focusedRefresh =
    active?.closest("[data-chat-model-refresh]") && details.contains(active) ? active : undefined;
  // Catalog bindings settle first; preserve the query, selection, and refresh focus.
  queueMicrotask(() => {
    const input = state.inputs.values().next().value;
    if (input) {
      updateModelSearch(input, true);
    }
    if (
      focusedRefresh &&
      !focusedRefresh.isConnected &&
      details.isConnected &&
      details.open &&
      details.ownerDocument.activeElement === details.ownerDocument.body
    ) {
      const target = input && !input.disabled ? input : state.summary;
      target?.focus({ preventScroll: true });
    }
  });
}
