import { createMemo, createProjection, createSignal, createStore, onSettled } from "solid-js";
import {
  chatModelSearchState,
  type createChatModelSearch,
  type ChatModelSearchCatalog,
  type ChatModelSearchRow,
  type ChatModelSearchView,
} from "./chat-model-picker-search.ts";

type SearchMatch = { row: ChatModelSearchRow; rank: number };

const normalizeSearch = (value: string) => value.toLocaleLowerCase().normalize("NFC");

function modelMatchRank(row: ChatModelSearchRow, query: string): number | null {
  const name = normalizeSearch(row.name);
  if (name.startsWith(query)) {
    return 0;
  }
  if (name.includes(query)) {
    return 1;
  }
  if (row.keywords && normalizeSearch(row.keywords).includes(query)) {
    return 2;
  }
  const providerLabel = normalizeSearch(row.providerLabel);
  if (providerLabel.startsWith(query)) {
    return 3;
  }
  if (providerLabel.includes(query)) {
    return 4;
  }
  return normalizeSearch(row.reference).includes(query) ? 5 : null;
}

/** The retained lazy panel owns ranking and disclosure; input/shortcut admission stays eager. */
export function createChatModelSearchView(
  search: ReturnType<typeof createChatModelSearch>,
  read: () => ChatModelSearchCatalog,
  reveal: (key: string) => void,
) {
  const query = search.query;
  const listId = search.listId;
  const scope = createMemo(() => ({ active: read().activeProvider, providers: read().providers }), {
    equals: (a, b) => a.active === b.active && a.providers.join("\0") === b.providers.join("\0"),
  });
  // Closing and selection reset provider defaults; catalog refreshes retain each surviving choice.
  const [disclosure, updateDisclosure] = createStore<{
    active: string | undefined;
    selected?: string;
    groups: Record<string, { more: boolean }>;
  }>(
    (draft) => {
      const current = scope();
      const selectionChanged = draft.active !== current.active;
      draft.active = current.active;
      if (selectionChanged || !current.providers.includes(draft.selected ?? "")) {
        draft.selected = current.active ?? current.providers[0];
      }
      for (const provider of Object.keys(draft.groups)) {
        if (!current.providers.includes(provider)) {
          delete draft.groups[provider];
        }
      }
      for (const provider of current.providers) {
        draft.groups[provider] ??= { more: false };
      }
    },
    { active: undefined, groups: {} },
  );
  const providerOpen = (provider: string) => disclosure.selected === provider;
  const matches = createMemo(
    () => {
      const term = normalizeSearch(query().trim());
      const buckets: ChatModelSearchRow[][] = [[], [], [], [], [], []];
      for (const row of read().rows) {
        const score = term
          ? modelMatchRank(row, term)
          : (
                row.provider
                  ? providerOpen(row.provider) &&
                    (!row.more || disclosure.groups[row.provider]?.more)
                  : row.visible !== false
              )
            ? 0
            : null;
        if (score !== null) {
          buckets[score]!.push(row);
        }
      }
      const ranked: SearchMatch[] = [];
      for (const bucket of buckets) {
        for (const row of bucket) {
          ranked.push({ row, rank: ranked.length });
        }
      }
      return ranked;
    },
    {
      equals: (a, b) =>
        a.length === b.length && a.every((match, index) => match.row === b[index]!.row),
    },
  );
  const selectable = createMemo(() => matches().filter(({ row }) => !row.disabled));
  // Browsing providers is neutral; typing or arrow navigation establishes a highlight.
  const [highlighted, highlight] = createSignal<string | undefined>((previous) => {
    const rows = selectable();
    return (
      rows.find(({ row }) => row.key === previous)?.row.key ??
      (query().trim() ? rows[0]?.row.key : undefined)
    );
  });
  // A highlight move changes only its old and new rows, including offscreen choices.
  const highlightedRows = createProjection<Record<string, true | undefined>>(() => {
    const key = highlighted();
    return key === undefined ? {} : { [key]: true };
  });
  const rowStates = createProjection<Record<string, ReturnType<ChatModelSearchView["row"]>>>(() => {
    const states: Record<string, ReturnType<ChatModelSearchView["row"]>> = {};
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
    isHighlighted: (key: string) => highlightedRows[key] === true,
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
      updateDisclosure((draft) => {
        draft.selected = provider;
      });
    },
    resetProvider() {
      const current = scope();
      updateDisclosure((draft) => {
        draft.selected = current.active ?? current.providers[0];
      });
    },
    expandMore(provider: string, event: MouseEvent) {
      event.stopPropagation();
      const state = chatModelSearchState(event.currentTarget);
      const hadFocus = event.currentTarget === state?.details?.ownerDocument.activeElement;
      updateDisclosure((draft) => {
        draft.groups[provider]!.more = true;
      });
      if (hadFocus && state) {
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
  search.bindView(view);
  return view;
}

export function updateModelSearch(input: HTMLInputElement): void {
  const state = chatModelSearchState(input);
  if (state) {
    state.setQuery(input.value);
    state.view?.highlight(undefined);
  }
}

export function handleModelSearchKeydown(event: KeyboardEvent): void {
  if (
    event.isComposing ||
    event.keyCode === 229 ||
    !["Enter", "ArrowDown", "ArrowUp"].includes(event.key)
  ) {
    return;
  }
  const state = chatModelSearchState(event.currentTarget);
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
  const highlighted = view.highlighted();
  const index = rows.findIndex(({ row }) =>
    highlighted === undefined ? row.selected : row.key === highlighted,
  );
  const offset = event.key === "ArrowDown" ? 1 : rows.length - 1;
  const next =
    rows[
      index < 0 ? (event.key === "ArrowDown" ? 0 : rows.length - 1) : (index + offset) % rows.length
    ];
  if (next) {
    view.highlight(next.row.key);
    view.reveal(next.row.key);
  }
}
