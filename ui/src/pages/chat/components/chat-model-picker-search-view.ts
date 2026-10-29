import { createMemo, createProjection, createSignal, createStore, onSettled } from "solid-js";
import {
  chatModelSearchState,
  type createChatModelSearch,
  type ChatModelSearchCatalog,
  type ChatModelSearchRow,
  type ChatModelSearchView,
} from "./chat-model-picker-search.ts";

type SearchMatch = { row: ChatModelSearchRow; rank: number };

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
      const next = !providerOpen(provider);
      updateDisclosure((draft) => {
        draft.groups[provider]!.open = next;
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

export function handleModelOptionMouseEnter(event: MouseEvent): void {
  const state = chatModelSearchState(event.currentTarget);
  if (event.currentTarget instanceof HTMLButtonElement) {
    const key = event.currentTarget.dataset.chatModelKey;
    if (key) {
      state?.view?.highlight(key);
    }
  }
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

/** A disappearing refresh control can return focus; catalog presentation is already derived. */
export function restoreChatModelRefreshFocus(details: Element | undefined): void {
  if (!(details instanceof HTMLDetailsElement) || !details.open) {
    return;
  }
  const state = chatModelSearchState(details);
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
