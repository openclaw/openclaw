import {
  createContext,
  createMemo,
  createProjection,
  createSignal,
  createStore,
  createUniqueId,
  onCleanup,
  onSettled,
} from "solid-js";
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
type SearchView = {
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
  view?: SearchView;
};
const pickers = new WeakMap<HTMLDetailsElement, ModelSearchState>();

function modelMatchRank(row: ChatModelSearchRow, query: string): number | null {
  if (row.name.startsWith(query)) {
    return 0;
  }
  if (row.name.includes(query)) {
    return 1;
  }
  if (row.keywords?.includes(query)) {
    return 2;
  }
  if (row.providerLabel.startsWith(query)) {
    return 3;
  }
  if (row.providerLabel.includes(query)) {
    return 4;
  }
  return row.reference.toLocaleLowerCase().includes(query) ? 5 : null;
}

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
    /** Initialize derivations under the retained lazy panel, without moving its catalog into boot. */
    createView(read: () => ChatModelSearchCatalog, reveal: (key: string) => void) {
      const scope = createMemo(
        () => ({ active: read().activeProvider, providers: read().providers }),
        {
          equals: (a, b) =>
            a.active === b.active && a.providers.join("\0") === b.providers.join("\0"),
        },
      );
      // Selection resets provider defaults; catalog refreshes retain each surviving choice.
      const [disclosure, updateDisclosure] = createStore<{
        active: string | undefined;
        groups: Record<string, { open?: boolean; more: boolean }>;
      }>(
        (draft) => {
          const current = scope();
          const selectionChanged = draft.active !== current.active;
          draft.active = current.active;
          for (const provider of Object.keys(draft.groups)) {
            if (!current.providers.includes(provider)) {
              delete draft.groups[provider];
            }
          }
          for (const provider of current.providers) {
            const group = (draft.groups[provider] ??= { more: false });
            if (selectionChanged) {
              delete group.open;
            }
          }
        },
        { active: undefined, groups: {} },
      );
      const providerOpen = (provider: string) =>
        disclosure.groups[provider]?.open ?? disclosure.active === provider;
      const matches = createMemo(
        () => {
          const term = query().trim().toLocaleLowerCase();
          return read()
            .rows.flatMap((row, index) => {
              const visible = row.provider
                ? providerOpen(row.provider) && (!row.more || disclosure.groups[row.provider]?.more)
                : row.visible !== false;
              const score = term ? modelMatchRank(row, term) : visible ? 0 : null;
              return score === null ? [] : [{ row, score, index }];
            })
            .toSorted((a, b) => a.score - b.score || a.index - b.index)
            .map(({ row }, rank): SearchMatch => ({ row, rank }));
        },
        {
          equals: (a, b) =>
            a.length === b.length && a.every((match, index) => match.row === b[index]!.row),
        },
      );
      const selectable = createMemo(() => matches().filter(({ row }) => !row.disabled));
      // Keep a surviving choice on refresh; a removed choice adopts the current fallback.
      const [highlighted, highlight] = createSignal<string | undefined>((previous) => {
        const rows = selectable();
        return (
          rows.find(({ row }) => row.key === previous)?.row.key ??
          (query().trim() ? undefined : rows.find(({ row }) => row.selected)?.row.key) ??
          rows[0]?.row.key
        );
      });
      const rowStates = createProjection<Record<string, ReturnType<SearchView["row"]>>>(() => {
        const states: Record<string, ReturnType<SearchView["row"]>> = {};
        const lists = new Map<string | undefined, string[]>();
        let selectableIndex = 0;
        for (const { row, rank } of matches()) {
          const shortcut = !row.disabled ? ++selectableIndex : undefined;
          states[row.key] = {
            hidden: false,
            rank,
            shortcut: row.hasShortcut && shortcut && shortcut <= 9 ? shortcut : undefined,
          };
          const list = lists.get(row.list) ?? [];
          list.push(row.key);
          lists.set(row.list, list);
        }
        for (const keys of lists.values()) {
          keys.forEach((key, index) => {
            states[key]!.position = index + 1;
            states[key]!.size = keys.length;
          });
        }
        return states;
      });
      const filtering = createMemo(() => Boolean(query().trim()));
      const view = {
        matches,
        selectable,
        reveal,
        highlighted,
        highlight,
        providerOpen,
        moreOpen: (provider: string) => disclosure.groups[provider]?.more ?? false,
        filtering,
        empty: () => Boolean(query().trim()) && matches().length === 0,
        controls: () => read().lists.map(listId).join(" "),
        row(key: string) {
          return rowStates[key] ?? { hidden: true, rank: undefined, shortcut: undefined };
        },
        toggleProvider(provider: string) {
          const next = !providerOpen(provider);
          updateDisclosure((draft) => {
            draft.groups[provider]!.open = next;
          });
        },
        expandMore(provider: string, event: MouseEvent) {
          event.stopPropagation();
          const hadFocus = event.currentTarget === state.details?.ownerDocument.activeElement;
          updateDisclosure((draft) => {
            draft.groups[provider]!.more = true;
          });
          if (hadFocus) {
            onSettled(() => {
              const next = selectable().find(({ row }) => row.provider === provider && row.more);
              if (next) {
                // The ref completes keyboard focus when a virtual row mounts.
                state.focusRow = next.row.key;
                reveal(next.row.key);
                const element = state.rows.get(next.row.key);
                if (element) {
                  state.focusRow = undefined;
                  element.focus({ preventScroll: true });
                }
              } else {
                state.input?.focus({ preventScroll: true });
              }
            });
          }
        },
      };
      // Rows read this synchronous bridge while mounting; cleanup belongs to this primitive.
      state.view = view;
      onCleanup(() => {
        if (state.view === view) {
          state.view = undefined;
        }
      });
      return view;
    },
  };
}

// Account sections also render independently outside a model picker.
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

export function handleModelOptionMouseEnter(event: MouseEvent): void {
  const state = pickerState(event.currentTarget);
  if (event.currentTarget instanceof HTMLButtonElement) {
    const key = event.currentTarget.dataset.chatModelKey;
    if (key) {
      state?.view?.highlight(key);
    }
  }
}

export function updateModelSearch(input: HTMLInputElement): void {
  const state = pickerState(input);
  if (state) {
    state.setQuery(input.value);
    state.view?.highlight(undefined);
  }
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
  const details = pickerState(input)?.details;
  if (details) {
    resetModelSearch(details);
  }
  event.preventDefault();
  event.stopPropagation();
  return true;
}

export function handleModelSearchKeydown(event: KeyboardEvent): void {
  if (
    event.isComposing ||
    event.keyCode === 229 ||
    !["Enter", "ArrowDown", "ArrowUp"].includes(event.key)
  ) {
    return;
  }
  const state = pickerState(event.currentTarget);
  const view = state?.view;
  const rows = view?.selectable() ?? [];
  if (!state || !view || !rows.length) {
    return;
  }
  event.preventDefault();
  if (event.key === "Enter") {
    const key = view.highlighted();
    if (key) {
      state.rows.get(key)?.click();
    }
    return;
  }
  const index = rows.findIndex(({ row }) => row.key === view.highlighted());
  const offset = event.key === "ArrowDown" ? 1 : rows.length - 1;
  const next = rows[index < 0 ? 0 : (index + offset) % rows.length];
  if (next) {
    view.highlight(next.row.key);
    view.reveal(next.row.key);
    onSettled(() => {
      // Chromium returns a promise; settlement callbacks must not return it as cleanup.
      state.rows.get(next.row.key)?.scrollIntoView?.({ block: "nearest" });
    });
  }
}

export function handleModelPickerKeydown(event: KeyboardEvent): void {
  const state = pickerState(event.currentTarget);
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

/** A disappearing refresh control can return focus; catalog presentation is already derived. */
export function restoreChatModelRefreshFocus(details: Element | undefined): void {
  if (!(details instanceof HTMLDetailsElement) || !details.open) {
    return;
  }
  const state = pickers.get(details);
  const active = details.ownerDocument.activeElement;
  if (!state || !active?.closest("[data-chat-model-refresh]") || !details.contains(active)) {
    return;
  }
  queueMicrotask(() => {
    if (
      !active.isConnected &&
      details.isConnected &&
      details.open &&
      details.ownerDocument.activeElement === details.ownerDocument.body
    ) {
      const target = state.input && !state.input.disabled ? state.input : state.summary;
      target?.focus({ preventScroll: true });
    }
  });
}
