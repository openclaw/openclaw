import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useGateway } from "@/hooks/use-gateway";
import type { AgentListResult, AgentFilesListResult } from "@/types/agents";

// ─── Types ───

type TriggerMode = "/" | "@" | "#";

type AutocompleteItem = {
  /** Display label (skill name, agent name, file name) */
  label: string;
  /** Text to insert when selected */
  insertText: string;
  /** Optional description shown as muted secondary text */
  description?: string;
  /** Optional emoji/icon prefix */
  emoji?: string;
};

type SkillsListResult = {
  skills: Array<{
    name: string;
    description?: string;
    installed?: boolean;
    version?: string;
    command?: string;
  }>;
};

// ─── Cache ───

type CachedData<T> = { data: T; timestamp: number };
const CACHE_TTL_MS = 30_000;

const dataCache: {
  skills?: CachedData<AutocompleteItem[]>;
  agents?: CachedData<AutocompleteItem[]>;
  files?: CachedData<AutocompleteItem[]>;
} = {};

// ─── Hook: useAutocomplete ───

type AutocompleteState = {
  isOpen: boolean;
  triggerMode: TriggerMode | null;
  query: string;
  /** Character index in the input where the trigger starts */
  triggerStart: number;
  items: AutocompleteItem[];
  filteredItems: AutocompleteItem[];
  selectedIndex: number;
  loading: boolean;
};

const INITIAL_STATE: AutocompleteState = {
  isOpen: false,
  triggerMode: null,
  query: "",
  triggerStart: -1,
  items: [],
  filteredItems: [],
  selectedIndex: 0,
  loading: false,
};

const MAX_VISIBLE = 8;

export function useAutocomplete(
  inputValue: string,
  setInputValue: (valOrFn: string | ((prev: string) => string)) => void,
) {
  const { sendRpc } = useGateway();
  const [state, setState] = useState<AutocompleteState>(INITIAL_STATE);
  const fetchingRef = useRef(false);

  // Fetch data for a given trigger mode, using cache when fresh
  const fetchItems = useCallback(
    async (mode: TriggerMode): Promise<AutocompleteItem[]> => {
      const cacheKey = mode === "/" ? "skills" : mode === "@" ? "agents" : "files";
      const cached = dataCache[cacheKey];
      if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        return cached.data;
      }

      try {
        let items: AutocompleteItem[] = [];

        if (mode === "/") {
          const result = await sendRpc<SkillsListResult>("skills.list", {});
          items = (result?.skills ?? []).map((s) => ({
            label: s.command ?? s.name,
            insertText: `/${s.command ?? s.name} `,
            description: s.description,
            emoji: undefined,
          }));
        } else if (mode === "@") {
          const result = await sendRpc<AgentListResult>("agents.list");
          items = (result?.agents ?? []).map((a) => ({
            label: a.name ?? a.id,
            insertText: `@${a.id} `,
            description: a.role ?? a.department,
            emoji: a.identity?.emoji,
          }));
        } else if (mode === "#") {
          const agentsResult = await sendRpc<AgentListResult>("agents.list");
          const defaultAgentId = agentsResult?.defaultId ?? "main";
          const result = await sendRpc<AgentFilesListResult>("agents.files.list", {
            agentId: defaultAgentId,
          });
          items = (result?.files ?? [])
            .filter((f) => !f.missing)
            .map((f) => ({
              label: f.name,
              insertText: `#${f.name} `,
              description: f.size != null ? formatFileSize(f.size) : undefined,
              emoji: undefined,
            }));
        }

        dataCache[cacheKey] = { data: items, timestamp: Date.now() };
        return items;
      } catch {
        return dataCache[cacheKey]?.data ?? [];
      }
    },
    [sendRpc],
  );

  // Detect trigger characters in the input at cursor position
  const detectTrigger = useCallback(
    (value: string, cursorPos?: number): { mode: TriggerMode; start: number; query: string } | null => {
      const pos = cursorPos ?? value.length;
      // Walk backwards from cursor to find trigger character
      let i = pos - 1;
      while (i >= 0) {
        const ch = value[i];
        // If we hit a space or newline before finding a trigger, no match
        if (ch === " " || ch === "\n" || ch === "\r") {
          return null;
        }
        if (ch === "/" || ch === "@" || ch === "#") {
          // Trigger must be at start of input or preceded by a space/newline
          if (i === 0 || value[i - 1] === " " || value[i - 1] === "\n") {
            const mode = ch as TriggerMode;
            const query = value.slice(i + 1, pos);
            return { mode, start: i, query };
          }
          return null;
        }
        i--;
      }
      return null;
    },
    [],
  );

  // Handle input changes to detect triggers
  const handleInputChange = useCallback(
    (value: string, cursorPos?: number) => {
      const trigger = detectTrigger(value, cursorPos);

      if (!trigger) {
        if (state.isOpen) {
          setState(INITIAL_STATE);
        }
        return;
      }

      // If mode changed, fetch new data
      if (!state.isOpen || state.triggerMode !== trigger.mode) {
        setState((prev) => ({
          ...prev,
          isOpen: true,
          triggerMode: trigger.mode,
          query: trigger.query,
          triggerStart: trigger.start,
          selectedIndex: 0,
          loading: true,
          items: [],
          filteredItems: [],
        }));

        if (!fetchingRef.current) {
          fetchingRef.current = true;
          fetchItems(trigger.mode).then((items) => {
            fetchingRef.current = false;
            const filtered = filterItems(items, trigger.query);
            setState((prev) => ({
              ...prev,
              items,
              filteredItems: filtered,
              selectedIndex: 0,
              loading: false,
            }));
          });
        }
      } else {
        // Same mode, just update filter
        const filtered = filterItems(state.items, trigger.query);
        setState((prev) => ({
          ...prev,
          query: trigger.query,
          triggerStart: trigger.start,
          filteredItems: filtered,
          selectedIndex: Math.min(prev.selectedIndex, Math.max(0, filtered.length - 1)),
        }));
      }
    },
    [state.isOpen, state.triggerMode, state.items, detectTrigger, fetchItems],
  );

  // Select an item and insert it into the input
  const selectItem = useCallback(
    (index: number) => {
      const item = state.filteredItems[index];
      if (!item) {
        return;
      }
      const before = inputValue.slice(0, state.triggerStart);
      const after = inputValue.slice(state.triggerStart + 1 + state.query.length);
      setInputValue(before + item.insertText + after);
      setState(INITIAL_STATE);
    },
    [state.filteredItems, state.triggerStart, state.query, inputValue, setInputValue],
  );

  // Handle keyboard events (returns true if event was consumed)
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent): boolean => {
      if (!state.isOpen || state.filteredItems.length === 0) {
        return false;
      }

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setState((prev) => ({
            ...prev,
            selectedIndex: (prev.selectedIndex + 1) % prev.filteredItems.length,
          }));
          return true;

        case "ArrowUp":
          e.preventDefault();
          setState((prev) => ({
            ...prev,
            selectedIndex:
              (prev.selectedIndex - 1 + prev.filteredItems.length) % prev.filteredItems.length,
          }));
          return true;

        case "Enter":
        case "Tab":
          e.preventDefault();
          selectItem(state.selectedIndex);
          return true;

        case "Escape":
          e.preventDefault();
          setState(INITIAL_STATE);
          return true;

        default:
          return false;
      }
    },
    [state.isOpen, state.filteredItems.length, state.selectedIndex, selectItem],
  );

  // Dismiss the autocomplete
  const dismiss = useCallback(() => {
    setState(INITIAL_STATE);
  }, []);

  return {
    isOpen: state.isOpen,
    triggerMode: state.triggerMode,
    filteredItems: state.filteredItems,
    selectedIndex: state.selectedIndex,
    loading: state.loading,
    handleInputChange,
    handleKeyDown,
    selectItem,
    dismiss,
  };
}

// ─── Helpers ───

function filterItems(items: AutocompleteItem[], query: string): AutocompleteItem[] {
  if (!query) {
    return items;
  }
  const lower = query.toLowerCase();
  return items.filter(
    (item) =>
      item.label.toLowerCase().includes(lower) ||
      item.description?.toLowerCase().includes(lower),
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── Component: AutocompleteMenu ───

type AutocompleteMenuProps = {
  isOpen: boolean;
  triggerMode: TriggerMode | null;
  items: AutocompleteItem[];
  selectedIndex: number;
  loading: boolean;
  onSelect: (index: number) => void;
};

const TRIGGER_LABELS: Record<TriggerMode, string> = {
  "/": "Skills",
  "@": "Agents",
  "#": "Memory",
};

const TRIGGER_ICONS: Record<TriggerMode, string> = {
  "/": "/",
  "@": "@",
  "#": "#",
};

export function AutocompleteMenu({
  isOpen,
  triggerMode,
  items,
  selectedIndex,
  loading,
  onSelect,
}: AutocompleteMenuProps) {
  const listRef = useRef<HTMLDivElement>(null);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) {
      return;
    }
    const selected = listRef.current.children[selectedIndex + 1] as HTMLElement | undefined;
    if (selected) {
      selected.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  if (!isOpen || !triggerMode) {
    return null;
  }

  if (loading && items.length === 0) {
    return (
      <div className="absolute bottom-full left-0 right-0 mb-2 z-50 animate-in fade-in slide-in-from-bottom-2 duration-150">
        <div className="mx-auto max-w-4xl">
          <div className="rounded-xl border border-border/60 bg-popover/95 backdrop-blur-md shadow-lg p-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-primary/10 text-primary text-[10px] font-bold">
                {TRIGGER_ICONS[triggerMode]}
              </span>
              <span>Loading {TRIGGER_LABELS[triggerMode].toLowerCase()}...</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="absolute bottom-full left-0 right-0 mb-2 z-50 animate-in fade-in slide-in-from-bottom-2 duration-150">
        <div className="mx-auto max-w-4xl">
          <div className="rounded-xl border border-border/60 bg-popover/95 backdrop-blur-md shadow-lg p-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-primary/10 text-primary text-[10px] font-bold">
                {TRIGGER_ICONS[triggerMode]}
              </span>
              <span>No matching {TRIGGER_LABELS[triggerMode].toLowerCase()} found</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="absolute bottom-full left-0 right-0 mb-2 z-50 animate-in fade-in slide-in-from-bottom-2 duration-150">
      <div className="mx-auto max-w-4xl">
        <div
          ref={listRef}
          className="rounded-xl border border-border/60 bg-popover/95 backdrop-blur-md shadow-lg overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/40 bg-muted/30">
            <span className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-primary/10 text-primary text-[10px] font-bold">
              {TRIGGER_ICONS[triggerMode]}
            </span>
            <span className="text-[11px] font-mono text-muted-foreground">
              {TRIGGER_LABELS[triggerMode]}
            </span>
            {items.length > MAX_VISIBLE && (
              <span className="text-[10px] text-muted-foreground/50 ml-auto">
                {items.length} items
              </span>
            )}
          </div>

          {/* Items — capped at ~320px height with scroll for long lists */}
          <div className="overflow-y-auto max-h-[320px]">
            {items.map((item, i) => (
              <button
                key={item.label}
                type="button"
                className={cn(
                  "flex items-center gap-2.5 w-full px-3 py-2 text-left text-sm transition-colors duration-75",
                  i === selectedIndex
                    ? "bg-primary/15 text-foreground"
                    : "text-foreground/80 hover:bg-muted/50",
                  i < items.length - 1 && "border-b border-border/20",
                )}
                onMouseDown={(e) => {
                  // Use mouseDown instead of click to fire before blur
                  e.preventDefault();
                  onSelect(i);
                }}
              >
                {/* Icon/emoji */}
                <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-muted/60 text-xs shrink-0">
                  {item.emoji ?? TRIGGER_ICONS[triggerMode]}
                </span>

                {/* Label + description */}
                <div className="flex-1 min-w-0">
                  <span className="font-medium text-[13px]">{item.label}</span>
                  {item.description && (
                    <span className="ml-2 text-xs text-muted-foreground truncate">
                      {item.description}
                    </span>
                  )}
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
