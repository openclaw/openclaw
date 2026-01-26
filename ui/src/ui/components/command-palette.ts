/**
 * Command Palette Component
 * A searchable command launcher triggered by Cmd/Ctrl+K
 */

import { html, nothing } from "lit";
import { icon, type IconName } from "../icons";
import type { Tab } from "../navigation";

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

function fuzzyScorePart(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  const t = text.trim().toLowerCase();

  if (!q) return 0;
  if (!t) return 0;

  if (t === q) return 1000;
  if (t.startsWith(q)) return 700;

  const containsAt = t.indexOf(q);
  if (containsAt !== -1) {
    // Prefer matches closer to the beginning.
    return 500 - Math.min(containsAt * 5, 250);
  }

  // Fuzzy character match (in-order). Scores consecutive matches higher.
  let score = 0;
  let qIndex = 0;
  let consecutive = 0;

  for (let i = 0; i < t.length && qIndex < q.length; i++) {
    if (t[i] === q[qIndex]) {
      const isWordBoundary =
        i === 0 ||
        t[i - 1] === " " ||
        t[i - 1] === "-" ||
        t[i - 1] === "_" ||
        t[i - 1] === "/";

      score += 12 + consecutive * 6 + (isWordBoundary ? 10 : 0);
      consecutive++;
      qIndex++;
    } else {
      consecutive = 0;
    }
  }

  // Must match all query characters.
  if (qIndex < q.length) return 0;

  // Prefer shorter strings when scores are otherwise similar.
  return score - Math.min(t.length, 100) * 0.25;
}

function scoreCommand(cmd: Command, query: string): number {
  const parts = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  if (parts.length === 0) return 0;

  let total = 0;
  for (const part of parts) {
    const labelScore = fuzzyScorePart(part, cmd.label);
    const categoryScore = cmd.category ? fuzzyScorePart(part, cmd.category) * 0.8 : 0;
    const idScore = fuzzyScorePart(part, cmd.id) * 0.3;

    const best = Math.max(labelScore, categoryScore, idScore);
    if (best <= 0) return 0;
    total += best;
  }

  return total;
}

function filterCommands(commands: Command[], query: string): Command[] {
  if (!query.trim()) return commands;

  return commands
    .map((cmd, index) => ({ cmd, index, score: scoreCommand(cmd, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      const scoreDiff = b.score - a.score;
      if (scoreDiff !== 0) return scoreDiff;
      return a.index - b.index;
    })
    .map((entry) => entry.cmd);
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

  // Group commands by category
  const grouped = new Map<string, Command[]>();
  for (const cmd of filtered) {
    const cat = cmd.category ?? "Actions";
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(cmd);
  }

  let globalIndex = 0;
  const renderItem = (cmd: Command) => {
    const idx = globalIndex++;
    const isSelected = idx === state.selectedIndex;
    return html`
      <button
        class="command-palette__item ${isSelected ? "command-palette__item--selected" : ""}"
        @click=${() => onSelect(cmd)}
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
              handlePaletteKeydown(e, state, filtered, onClose, onSelect, onIndexChange)}
            autofocus
          />
          <kbd class="command-palette__kbd">ESC</kbd>
        </div>
        <div class="command-palette__list">
          ${filtered.length === 0
            ? html`<div class="command-palette__empty">
                ${icon("search", { size: 24 })}
                <span>No commands found</span>
              </div>`
            : [...grouped.entries()].map(
                ([category, cmds]) => html`
                  <div class="command-palette__group">
                    <div class="command-palette__group-label">${category}</div>
                    ${cmds.map(renderItem)}
                  </div>
                `
              )}
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
