import { createContext, createSignal, createUniqueId, onCleanup, onSettled } from "solid-js";
import { registerMenuShortcuts } from "../../../components/menu-shortcuts.ts";
import { elementRef } from "../../../lib/reactive/element-ref.ts";

export type ChatModelSearchRow = {
  key: string;
  list?: string;
  name: string;
  keywords?: string;
  providerLabel: string;
  reference: string;
  disabled: boolean;
  selected: boolean;
  /** Rows without keycaps still consume digit positions, but do not advertise global shortcuts. */
  hasShortcut: boolean;
  provider?: string;
  more?: boolean;
  visible?: boolean;
};

export type ChatModelSearchCatalog = {
  activeProvider?: string;
  providers: readonly string[];
  lists: readonly string[];
  rows: readonly ChatModelSearchRow[];
};

type SearchMatch = { row: ChatModelSearchRow; rank: number };
export type ChatModelSearchView = {
  matches(): SearchMatch[];
  selectable(): SearchMatch[];
  reveal(key: string): void;
  highlighted(): string | undefined;
  highlight(value: string | undefined): void;
  providerOpen(provider: string): boolean;
  moreOpen(provider: string): boolean;
  filtering(): boolean;
  empty(): boolean;
  controls(): string;
  row(key: string): {
    hidden: boolean;
    rank: number | undefined;
    shortcut: number | undefined;
    position?: number;
    size?: number;
  };
  toggleProvider(provider: string): void;
  expandMore(provider: string, event: MouseEvent): void;
};
type ModelSearchState = {
  details?: HTMLDetailsElement;
  summary?: HTMLElement;
  input?: HTMLInputElement;
  focusRow?: string;
  rows: Map<string, HTMLButtonElement>;
  query(): string;
  setQuery(value: string): void;
  view?: ChatModelSearchView;
};
const pickers = new WeakMap<HTMLDetailsElement, ModelSearchState>();

/** The lazy panel supplies a catalog accessor; only focus and activation retain DOM refs. */
export function createChatModelSearch() {
  const prefix = `chat-model-picker-${createUniqueId()}`;
  const [query, setQuery] = createSignal("");
  const [open, setOpen] = createSignal(false);
  const state: ModelSearchState = { rows: new Map(), query, setQuery };
  const optionId = (key: string) => `${prefix}-option-${encodeURIComponent(key)}`;
  const listId = (key: string) => `${prefix}-list-${encodeURIComponent(key)}`;
  onSettled(() =>
    state.details
      ? registerMenuShortcuts(state.details, () =>
          (state.view?.selectable() ?? []).slice(0, 9).flatMap(({ row }, index) => {
            const element = state.rows.get(row.key);
            return row.hasShortcut && element ? [{ element, key: String(index + 1) }] : [];
          }),
        )
      : undefined,
  );
  return {
    query,
    open,
    optionId,
    listId,
    setOpen,
    detailsRef: elementRef<HTMLDetailsElement>((element) => {
      state.details = element;
      pickers.set(element, state);
      return () => pickers.delete(element);
    }),
    summaryRef(this: void, element: HTMLElement) {
      state.summary = element;
    },
    inputRef() {
      return elementRef<HTMLInputElement>((element) => {
        state.input = element;
        return () => {
          if (state.input === element) {
            state.input = undefined;
          }
        };
      });
    },
    rowRef(readKey: () => string) {
      let element: HTMLButtonElement;
      onSettled(() => {
        // The keyed row keeps this identity for its mounted lifetime.
        const initialKey = readKey();
        state.rows.set(initialKey, element);
        if (state.focusRow === initialKey) {
          state.focusRow = undefined;
          if (state.details?.open) {
            element.focus({ preventScroll: true });
          }
        }
        return () => {
          if (state.rows.get(initialKey) === element) {
            state.rows.delete(initialKey);
          }
        };
      });
      return (node: HTMLButtonElement) => (element = node);
    },
    row(key: string) {
      return state.view?.row(key);
    },
    highlighted: () => state.view?.highlighted(),
    bindView(view: ChatModelSearchView) {
      // Rows read this synchronous bridge while mounting; cleanup belongs to this primitive.
      state.view = view;
      onCleanup(() => {
        if (state.view === view) {
          state.view = undefined;
        }
      });
    },
  };
}

// Account sections also render independently outside a model picker.
export const ChatModelSearchContext = createContext<ReturnType<
  typeof createChatModelSearch
> | null>(null);

export function chatModelSearchState(target: EventTarget | null): ModelSearchState | undefined {
  const details =
    target instanceof Element
      ? target.closest<HTMLDetailsElement>(".chat-controls__model-picker")
      : null;
  return details ? pickers.get(details) : undefined;
}

export function resetModelSearch(details: HTMLDetailsElement): void {
  const state = pickers.get(details);
  if (state) {
    state.focusRow = undefined;
  }
  const rows = state?.view?.selectable() ?? [];
  // An unchanged empty query cannot invalidate the writable highlight derivation.
  const fallback = rows.find(({ row }) => row.selected) ?? rows[0];
  state?.view?.highlight(state.query().trim() ? undefined : fallback?.row.key);
  state?.setQuery("");
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
  const details = chatModelSearchState(input)?.details;
  if (details) {
    resetModelSearch(details);
  }
  event.preventDefault();
  event.stopPropagation();
  return true;
}

export function handleModelPickerKeydown(event: KeyboardEvent): void {
  const state = chatModelSearchState(event.currentTarget);
  const details = state?.details;
  if (
    !state ||
    event.defaultPrevented ||
    !details?.open ||
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
  event.preventDefault();
  const row = state.view?.selectable()[Number(event.key) - 1]?.row;
  if (row) {
    state.rows.get(row.key)?.click();
  }
}
