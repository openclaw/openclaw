import { createContext, createSignal, createUniqueId, onCleanup } from "solid-js";
import { elementRef } from "../../../lib/reactive/element-ref.ts";

export type ChatModelSearchRow = {
  key: string;
  list?: string;
  name: string;
  keywords?: string;
  providerLabel: string;
  reference: string;
  recommended?: boolean;
  disabled: boolean;
  selected: boolean;
  /** Rows without global shortcuts still consume digit positions. */
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
  focusSearch(): void;
  onPickerKeydown(event: KeyboardEvent): void;
  rowRef(readKey: () => string): (node: HTMLElement) => HTMLElement;
  matches(): SearchMatch[];
  selectable(): SearchMatch[];
  reveal(key: string): void;
  highlighted(): string | undefined;
  isHighlighted(key: string): boolean;
  highlight(value: string | undefined): void;
  providerOpen(provider: string): boolean;
  /** Return to the opening provider so a closed picker never reopens elsewhere. */
  resetProvider(): void;
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
  pendingSearchFocus?: Element | null;
  focusRow?: string;
  rows: Map<string, HTMLElement>;
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
    focusOnOpen() {
      state.pendingSearchFocus = state.details?.ownerDocument.activeElement;
      requestAnimationFrame(() => state.view?.focusSearch());
    },
    rowRef(readKey: () => string) {
      return state.view?.rowRef(readKey);
    },
    row(key: string) {
      return state.view?.row(key);
    },
    highlighted: () => state.view?.highlighted(),
    isHighlighted: (key: string) => state.view?.isHighlighted(key) ?? false,
    bindView(view: ChatModelSearchView) {
      // Rows read this synchronous bridge while mounting; cleanup belongs to this primitive.
      state.view = view;
      onCleanup(() => {
        if (state.view === view) {
          state.view = undefined;
        }
      });
      return state;
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
  // Clear explicit navigation even when the query is already empty.
  state?.view?.highlight(undefined);
  // Escape also clears search while open; only dismissal resets the tab.
  if (!details.open) {
    if (state) {
      state.pendingSearchFocus = undefined;
    }
    state?.view?.resetProvider();
  }
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
  // Before the lazy panel binds its view, there are no shortcut targets.
  chatModelSearchState(event.currentTarget)?.view?.onPickerKeydown(event);
}
