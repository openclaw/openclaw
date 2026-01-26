/**
 * Command Palette Component
 * A searchable command launcher triggered by Cmd/Ctrl+K
 */

import { html, nothing } from "lit";
import { icon, type IconName } from "../icons";
import type { Tab } from "../navigation";
import { filterByFuzzy } from "./fuzzy-search";
import { getRecentCommandIds, recordCommandUsage } from "./command-history";

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
};

export type CommandPaletteProps = {
  state: CommandPaletteState;
  commands: Command[];
  onClose: () => void;
  onQueryChange: (query: string) => void;
  onIndexChange: (index: number) => void;
  onSelect: (command: Command) => void;
};

function filterCommands(commands: Command[], query: string): Command[] {
  return filterByFuzzy(commands, query);
}

function handlePaletteKeydown(
  e: KeyboardEvent,
  state: CommandPaletteState,
  filtered: Command[],
  onClose: () => void,
  onSelect: (cmd: Command) => void,
  onIndexChange: (index: number) => void
) {
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

export function renderCommandPalette(props: CommandPaletteProps) {
  const { state, commands, onClose, onQueryChange, onIndexChange, onSelect } = props;

  if (!state.open) return nothing;

  const filtered = filterCommands(commands, state.query);

  // Build the "Recents" group when the query is empty.
  const recentIds = !state.query.trim() ? getRecentCommandIds() : [];
  const commandById = new Map(commands.map((c) => [c.id, c]));
  const recentCommands = recentIds
    .map((id) => commandById.get(id))
    .filter((c): c is Command => c !== undefined);

  // IDs already shown in Recents — avoid duplicating them in the main list.
  const recentIdSet = new Set(recentCommands.map((c) => c.id));

  // Group commands by category, excluding recents when they are shown.
  const grouped = new Map<string, Command[]>();
  for (const cmd of filtered) {
    if (recentCommands.length > 0 && recentIdSet.has(cmd.id)) continue;
    const cat = cmd.category ?? "Actions";
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(cmd);
  }

  // Wrap onSelect to record history.
  const handleSelect = (cmd: Command) => {
    recordCommandUsage(cmd.id);
    onSelect(cmd);
  };

  // Total visible items = recents + remaining grouped items.
  const totalVisible =
    recentCommands.length +
    [...grouped.values()].reduce((sum, cmds) => sum + cmds.length, 0);

  let globalIndex = 0;
  const renderItem = (cmd: Command) => {
    const idx = globalIndex++;
    const isSelected = idx === state.selectedIndex;
    return html`
      <button
        class="command-palette__item ${isSelected ? "command-palette__item--selected" : ""}"
        @click=${() => handleSelect(cmd)}
        @mouseenter=${() => onIndexChange(idx)}
        data-index=${idx}
      >
        <span class="command-palette__item-icon">${icon(cmd.icon, { size: 16 })}</span>
        <span class="command-palette__item-label">${cmd.label}</span>
        ${cmd.shortcut
          ? html`<kbd class="command-palette__item-shortcut">${cmd.shortcut}</kbd>`
          : nothing}
      </button>
    `;
  };

  // Build the flat list for keyboard navigation (recents first, then grouped).
  const allVisible = [...recentCommands, ...[...grouped.values()].flat()];

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
              handlePaletteKeydown(e, state, allVisible, onClose, handleSelect, onIndexChange)}
            autofocus
          />
          <kbd class="command-palette__kbd">ESC</kbd>
        </div>
        <div class="command-palette__list">
          ${totalVisible === 0
            ? html`<div class="command-palette__empty">
                ${icon("search", { size: 24 })}
                <span>No commands found</span>
              </div>`
            : html`
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
  toggleTheme: () => void
): Command[] {
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const mod = isMac ? "⌘" : "Ctrl+";

  return [
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
      break;
  }

  return cmds;
}
