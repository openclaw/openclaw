/**
 * Command Palette Component
 * A searchable command launcher triggered by Cmd/Ctrl+K
 */

import { html, nothing } from "lit";
import { icon, type IconName } from "../icons";
import type { Tab } from "../navigation";
import { filterByFuzzy } from "./fuzzy-search";
import { getRecentCommandIds, recordCommandUsage } from "./command-history";
import { getFavoriteIds, isFavorite, toggleFavorite } from "./command-favorites";

export type Command = {
  id: string;
  label: string;
  icon: IconName;
  shortcut?: string;
  action: () => void;
  category?: string;
};

export type CommandPaletteState = {
  open: boolean;
  query: string;
  selectedIndex: number;
  /** Active category filter ("All" shows everything). */
  activeCategory: string;
};

export type CommandPaletteProps = {
  state: CommandPaletteState;
  commands: Command[];
  onClose: () => void;
  onQueryChange: (query: string) => void;
  onIndexChange: (index: number) => void;
  onCategoryChange: (category: string) => void;
  onSelect: (command: Command) => void;
  /** Called after a favorite is toggled so the parent can trigger re-render. */
  onFavoritesChange?: () => void;
};

function filterCommands(commands: Command[], query: string): Command[] {
  return filterByFuzzy(commands, query);
}

function handlePaletteKeydown(
  e: KeyboardEvent,
  state: CommandPaletteState,
  filtered: Command[],
  categories: string[],
  onClose: () => void,
  onSelect: (cmd: Command) => void,
  onIndexChange: (index: number) => void,
  onCategoryChange: (cat: string) => void,
  onToggleFavorite?: (cmd: Command) => void
) {
  // Ctrl/Cmd + D → toggle favorite on the selected item.
  if (e.key === "d" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    const selected = filtered[state.selectedIndex];
    if (selected && onToggleFavorite) onToggleFavorite(selected);
    return;
  }

  // Tab / Shift+Tab → cycle categories.
  if (e.key === "Tab") {
    e.preventDefault();
    const idx = categories.indexOf(state.activeCategory);
    const next = e.shiftKey
      ? (idx - 1 + categories.length) % categories.length
      : (idx + 1) % categories.length;
    onCategoryChange(categories[next]);
    onIndexChange(0);
    return;
  }

  // Backspace on empty query → reset category to "All".
  if (e.key === "Backspace" && !state.query && state.activeCategory !== "All") {
    e.preventDefault();
    onCategoryChange("All");
    onIndexChange(0);
    return;
  }

  switch (e.key) {
    case "Escape":
      e.preventDefault();
      onClose();
      break;
    case "ArrowDown":
      e.preventDefault();
      onIndexChange(Math.min(state.selectedIndex + 1, filtered.length - 1));
      break;
    case "ArrowUp":
      e.preventDefault();
      onIndexChange(Math.max(state.selectedIndex - 1, 0));
      break;
    case "Enter":
      e.preventDefault();
      if (filtered[state.selectedIndex]) {
        onSelect(filtered[state.selectedIndex]);
      }
      break;
  }
}

/** Extract unique category names from a list of commands (preserving order). */
function extractCategories(commands: Command[]): string[] {
  const seen = new Set<string>();
  const cats: string[] = [];
  for (const cmd of commands) {
    const cat = cmd.category ?? "Actions";
    if (!seen.has(cat)) {
      seen.add(cat);
      cats.push(cat);
    }
  }
  return cats;
}

export function renderCommandPalette(props: CommandPaletteProps) {
  const { state, commands, onClose, onQueryChange, onIndexChange, onCategoryChange, onSelect, onFavoritesChange } =
    props;

  if (!state.open) return nothing;

  // Category filter: "All" shows every command, otherwise only the chosen category.
  const categoryFiltered =
    state.activeCategory === "All"
      ? commands
      : commands.filter((c) => (c.category ?? "Actions") === state.activeCategory);

  const filtered = filterCommands(categoryFiltered, state.query);

  // Build the category pill list: ["All", ...unique categories from commands].
  const allCategories = ["All", ...extractCategories(commands)];

  // Build "Favorites" and "Recents" groups when the query is empty and category is "All".
  const noQuery = !state.query.trim();
  const showSpecialGroups = noQuery && state.activeCategory === "All";
  const favoriteIds = showSpecialGroups ? getFavoriteIds() : [];
  const recentIds = showSpecialGroups ? getRecentCommandIds() : [];
  const commandById = new Map(commands.map((c) => [c.id, c]));

  const favoriteCommands = favoriteIds
    .map((id) => commandById.get(id))
    .filter((c): c is Command => c !== undefined);
  const favoriteIdSet = new Set(favoriteCommands.map((c) => c.id));

  const recentCommands = recentIds
    .map((id) => commandById.get(id))
    .filter((c): c is Command => c !== undefined)
    // Don't duplicate commands already shown in Favorites.
    .filter((c) => !favoriteIdSet.has(c.id));
  const recentIdSet = new Set(recentCommands.map((c) => c.id));

  // IDs shown in Favorites or Recents — avoid duplicating them in the main list.
  const shownIds = new Set([...favoriteIdSet, ...recentIdSet]);

  // Group remaining commands by category.
  const grouped = new Map<string, Command[]>();
  for (const cmd of filtered) {
    if (shownIds.has(cmd.id)) continue;
    const cat = cmd.category ?? "Actions";
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(cmd);
  }

  // Wrap onSelect to record history.
  const handleSelect = (cmd: Command) => {
    recordCommandUsage(cmd.id);
    onSelect(cmd);
  };

  // Toggle favorite handler.
  const handleToggleFavorite = (cmd: Command) => {
    toggleFavorite(cmd.id);
    onFavoritesChange?.();
  };

  // Total visible items = favorites + recents + remaining grouped items.
  const totalVisible =
    favoriteCommands.length +
    recentCommands.length +
    [...grouped.values()].reduce((sum, cmds) => sum + cmds.length, 0);

  let globalIndex = 0;
  const renderItem = (cmd: Command) => {
    const idx = globalIndex++;
    const isSelected = idx === state.selectedIndex;
    const starred = isFavorite(cmd.id);
    return html`
      <button
        class="command-palette__item ${isSelected ? "command-palette__item--selected" : ""}"
        @click=${() => handleSelect(cmd)}
        @mouseenter=${() => onIndexChange(idx)}
        data-index=${idx}
      >
        <span class="command-palette__item-icon">${icon(cmd.icon, { size: 16 })}</span>
        <span class="command-palette__item-label">${cmd.label}</span>
        ${starred
          ? html`<span
              class="command-palette__item-fav"
              title="Favorited (${navigator.platform?.includes("Mac") ? "⌘" : "Ctrl+"}D to toggle)"
              @click=${(e: Event) => {
                e.stopPropagation();
                handleToggleFavorite(cmd);
              }}
              >★</span
            >`
          : nothing}
        ${cmd.shortcut
          ? html`<kbd class="command-palette__item-shortcut">${cmd.shortcut}</kbd>`
          : nothing}
      </button>
    `;
  };

  // Flat list for keyboard navigation: favorites first, then recents, then grouped.
  const allVisible = [...favoriteCommands, ...recentCommands, ...[...grouped.values()].flat()];

  return html`
    <div class="command-palette-overlay" @click=${onClose}>
      <div class="command-palette" @click=${(e: Event) => e.stopPropagation()}>
        <div class="command-palette__search">
          ${icon("search", { size: 18, class: "command-palette__search-icon" })}
          <input
            class="command-palette__input"
            type="text"
            placeholder="Type a command or search..."
            .value=${state.query}
            @input=${(e: Event) => {
              onQueryChange((e.target as HTMLInputElement).value);
              onIndexChange(0);
            }}
            @keydown=${(e: KeyboardEvent) =>
              handlePaletteKeydown(
                e,
                state,
                allVisible,
                allCategories,
                onClose,
                handleSelect,
                onIndexChange,
                onCategoryChange,
                handleToggleFavorite
              )}
            autofocus
          />
          <kbd class="command-palette__kbd">ESC</kbd>
        </div>
        <div class="command-palette__categories">
          ${allCategories.map(
            (cat) => html`
              <button
                class="command-palette__category ${cat === state.activeCategory
                  ? "command-palette__category--active"
                  : ""}"
                @click=${() => {
                  onCategoryChange(cat);
                  onIndexChange(0);
                }}
              >
                ${cat}
              </button>
            `
          )}
        </div>
        <div class="command-palette__list">
          ${totalVisible === 0
            ? html`<div class="command-palette__empty">
                ${icon("search", { size: 24 })}
                <span>No commands found</span>
              </div>`
            : html`
                ${favoriteCommands.length > 0
                  ? html`
                      <div class="command-palette__group">
                        <div class="command-palette__group-label">★ Favorites</div>
                        ${favoriteCommands.map(renderItem)}
                      </div>
                    `
                  : nothing}
                ${recentCommands.length > 0
                  ? html`
                      <div class="command-palette__group">
                        <div class="command-palette__group-label">Recents</div>
                        ${recentCommands.map(renderItem)}
                      </div>
                    `
                  : nothing}
                ${[...grouped.entries()].map(
                  ([category, cmds]) => html`
                    <div class="command-palette__group">
                      <div class="command-palette__group-label">${category}</div>
                      ${cmds.map(renderItem)}
                    </div>
                  `
                )}
              `}
        </div>
      </div>
    </div>
  `;
}

/**
 * Create default commands for navigation and common actions
 */
export function createDefaultCommands(
  setTab: (tab: Tab) => void,
  refresh: () => void,
  newSession: () => void,
  toggleTheme: () => void,
  extras?: {
    openKeyboardShortcuts?: () => void;
    openDocumentation?: () => void;
    copyGatewayUrl?: () => void;
  }
): Command[] {
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const mod = isMac ? "⌘" : "Ctrl+";

  const cmds: Command[] = [
    // Navigation
    { id: "nav-chat", label: "Go to Chat", icon: "message-square", shortcut: `${mod}1`, category: "Navigation", action: () => setTab("chat") },
    { id: "nav-overview", label: "Go to Overview", icon: "layout-dashboard", shortcut: `${mod}2`, category: "Navigation", action: () => setTab("overview") },
    { id: "nav-channels", label: "Go to Channels", icon: "link", shortcut: `${mod}3`, category: "Navigation", action: () => setTab("channels") },
    { id: "nav-sessions", label: "Go to Sessions", icon: "file-text", shortcut: `${mod}4`, category: "Navigation", action: () => setTab("sessions") },
    { id: "nav-instances", label: "Go to Instances", icon: "radio", category: "Navigation", action: () => setTab("instances") },
    { id: "nav-cron", label: "Go to Cron Jobs", icon: "clock", category: "Navigation", action: () => setTab("cron") },
    { id: "nav-skills", label: "Go to Skills", icon: "zap", category: "Navigation", action: () => setTab("skills") },
    { id: "nav-nodes", label: "Go to Nodes", icon: "server", category: "Navigation", action: () => setTab("nodes") },
    { id: "nav-config", label: "Go to Config", icon: "settings", shortcut: `${mod},`, category: "Navigation", action: () => setTab("config") },
    { id: "nav-debug", label: "Go to Debug", icon: "bug", category: "Navigation", action: () => setTab("debug") },
    { id: "nav-logs", label: "Go to Logs", icon: "scroll-text", category: "Navigation", action: () => setTab("logs") },
    // Actions
    { id: "action-refresh", label: "Refresh Current View", icon: "refresh-cw", shortcut: `${mod}R`, category: "Actions", action: refresh },
    { id: "action-new-session", label: "New Chat Session", icon: "plus", shortcut: `${mod}N`, category: "Actions", action: newSession },
    { id: "theme-toggle", label: "Toggle Theme", icon: "sun", shortcut: `${mod}T`, category: "Actions", action: toggleTheme },
  ];

  // System commands
  if (extras?.openKeyboardShortcuts) cmds.push({ id: "sys-keyboard-shortcuts", label: "Keyboard Shortcuts", icon: "keyboard", shortcut: `${mod}?`, category: "System", action: extras.openKeyboardShortcuts });
  if (extras?.openDocumentation) cmds.push({ id: "sys-open-docs", label: "Open Documentation", icon: "book-open", category: "System", action: extras.openDocumentation });
  if (extras?.copyGatewayUrl) cmds.push({ id: "sys-copy-url", label: "Copy Gateway URL", icon: "copy", category: "System", action: extras.copyGatewayUrl });

  return cmds;
}

/** Callbacks available for context-aware commands. Provide only what applies. */
export type ContextActions = {
  newSession?: () => void;
  clearChat?: () => void;
  abortChat?: () => void;
  refreshSessions?: () => void;
  refreshChannels?: () => void;
  addCronJob?: () => void;
  refreshCron?: () => void;
  createGoal?: () => void;
  refreshOverseer?: () => void;
  saveConfig?: () => void;
  refreshNodes?: () => void;
  clearLogs?: () => void;
  refreshSkills?: () => void;
  refreshDebug?: () => void;
  refreshInstances?: () => void;
  refreshOverview?: () => void;
  refreshAgents?: () => void;
  refreshLogs?: () => void;
  exportLogs?: () => void;
  toggleAutoFollow?: () => void;
  jumpToLogsBottom?: () => void;
  openKeyboardShortcuts?: () => void;
};

/**
 * Build commands that are only relevant for the currently active tab.
 * Returned commands use the category "Current View" so they appear grouped.
 */
export function createContextCommands(tab: Tab, actions: ContextActions): Command[] {
  const cmds: Command[] = [];
  const cat = "Current View";

  switch (tab) {
    case "chat":
      if (actions.newSession) cmds.push({ id: "ctx-new-session", label: "New Chat Session", icon: "plus", category: cat, action: actions.newSession });
      if (actions.clearChat) cmds.push({ id: "ctx-clear-chat", label: "Clear Chat History", icon: "trash-2", category: cat, action: actions.clearChat });
      if (actions.abortChat) cmds.push({ id: "ctx-abort-chat", label: "Abort Current Response", icon: "square", category: cat, action: actions.abortChat });
      break;
    case "sessions":
      if (actions.refreshSessions) cmds.push({ id: "ctx-refresh-sessions", label: "Refresh Sessions", icon: "refresh-cw", category: cat, action: actions.refreshSessions });
      break;
    case "channels":
      if (actions.refreshChannels) cmds.push({ id: "ctx-refresh-channels", label: "Refresh Channels", icon: "refresh-cw", category: cat, action: actions.refreshChannels });
      break;
    case "cron":
      if (actions.addCronJob) cmds.push({ id: "ctx-add-cron", label: "Add Cron Job", icon: "plus", category: cat, action: actions.addCronJob });
      if (actions.refreshCron) cmds.push({ id: "ctx-refresh-cron", label: "Refresh Cron Jobs", icon: "refresh-cw", category: cat, action: actions.refreshCron });
      break;
    case "overseer":
      if (actions.createGoal) cmds.push({ id: "ctx-create-goal", label: "Create New Goal", icon: "target", category: cat, action: actions.createGoal });
      if (actions.refreshOverseer) cmds.push({ id: "ctx-refresh-overseer", label: "Refresh Overseer", icon: "refresh-cw", category: cat, action: actions.refreshOverseer });
      break;
    case "config":
      if (actions.saveConfig) cmds.push({ id: "ctx-save-config", label: "Save Configuration", icon: "save", category: cat, action: actions.saveConfig });
      break;
    case "nodes":
      if (actions.refreshNodes) cmds.push({ id: "ctx-refresh-nodes", label: "Refresh Nodes", icon: "refresh-cw", category: cat, action: actions.refreshNodes });
      break;
    case "logs":
      if (actions.clearLogs) cmds.push({ id: "ctx-clear-logs", label: "Clear Log View", icon: "trash-2", category: cat, action: actions.clearLogs });
      if (actions.refreshLogs) cmds.push({ id: "ctx-refresh-logs", label: "Refresh Logs", icon: "refresh-cw", category: cat, action: actions.refreshLogs });
      if (actions.exportLogs) cmds.push({ id: "ctx-export-logs", label: "Export Logs", icon: "download", category: cat, action: actions.exportLogs });
      if (actions.toggleAutoFollow) cmds.push({ id: "ctx-toggle-follow", label: "Toggle Auto-Follow", icon: "arrow-down-to-line", category: cat, action: actions.toggleAutoFollow });
      if (actions.jumpToLogsBottom) cmds.push({ id: "ctx-jump-bottom", label: "Jump to Bottom", icon: "chevrons-down", category: cat, action: actions.jumpToLogsBottom });
      break;
    case "skills":
      if (actions.refreshSkills) cmds.push({ id: "ctx-refresh-skills", label: "Refresh Skills", icon: "refresh-cw", category: cat, action: actions.refreshSkills });
      break;
    case "debug":
      if (actions.refreshDebug) cmds.push({ id: "ctx-refresh-debug", label: "Refresh Debug", icon: "refresh-cw", category: cat, action: actions.refreshDebug });
      break;
    case "instances":
      if (actions.refreshInstances) cmds.push({ id: "ctx-refresh-instances", label: "Refresh Instances", icon: "refresh-cw", category: cat, action: actions.refreshInstances });
      break;
    case "overview":
      if (actions.refreshOverview) cmds.push({ id: "ctx-refresh-overview", label: "Refresh Overview", icon: "refresh-cw", category: cat, action: actions.refreshOverview });
      break;
    case "agents":
      if (actions.refreshAgents) cmds.push({ id: "ctx-refresh-agents", label: "Refresh Agents", icon: "refresh-cw", category: cat, action: actions.refreshAgents });
      break;
  }

  return cmds;
}
