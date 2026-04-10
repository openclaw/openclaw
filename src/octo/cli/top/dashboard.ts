// Octopus Orchestrator — `octo top` dashboard renderer
//
// Real-time TUI dashboard showing missions, arms, grips, claims.
// Refreshes on a configurable interval. Zero external dependencies.
//
// Boundary discipline (OCTO-DEC-033):
//   Only imports from `node:*` builtins and relative paths inside `src/octo/`.

import type {
  ArmRecord,
  ClaimRecord,
  GripRecord,
  MissionRecord,
  RegistryService,
} from "../../head/registry.ts";
import {
  CLEAR_SCREEN,
  CURSOR_HOME,
  CURSOR_HIDE,
  CURSOR_SHOW,
  center,
  fg,
  hr,
  padRight,
  statusBadge,
  style,
} from "./ansi.ts";
import type { KeyAction } from "./input.ts";
import { startKeyListener } from "./input.ts";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export interface TopOptions {
  refreshMs?: number;
}

type Tab = "missions" | "arms" | "grips" | "claims" | "events";

interface DashboardState {
  tab: Tab;
  selectedRow: number;
  showHelp: boolean;
  missions: MissionRecord[];
  arms: ArmRecord[];
  grips: GripRecord[];
  claims: ClaimRecord[];
  lastRefresh: number;
}

// ──────────────────────────────────────────────────────────────────────────
// Data gathering
// ──────────────────────────────────────────────────────────────────────────

function refreshData(registry: RegistryService, state: DashboardState): void {
  state.missions = registry.listMissions();
  state.arms = registry.listArms({});
  state.grips = registry.listGrips({});
  state.claims = registry.listClaims({});
  state.lastRefresh = Date.now();
}

// ──────────────────────────────────────────────────────────────────────────
// Rendering
// ──────────────────────────────────────────────────────────────────────────

const TABS: Tab[] = ["missions", "arms", "grips", "claims", "events"];

function getTermSize(): { rows: number; cols: number } {
  return {
    rows: process.stdout.rows || 24,
    cols: process.stdout.columns || 80,
  };
}

function renderHeader(state: DashboardState, cols: number): string[] {
  const lines: string[] = [];
  const title = style.bold("Octopus Orchestrator — Live Dashboard");
  const refreshAge = ((Date.now() - state.lastRefresh) / 1000).toFixed(0);
  const refreshStr = fg.gray("refreshed " + refreshAge + "s ago");
  lines.push(padRight(title + "  " + refreshStr, cols));
  lines.push(fg.gray(hr(cols)));

  // Summary bar
  const m = state.missions;
  const a = state.arms;
  const g = state.grips;
  const c = state.claims;
  const activeM = m.filter((x) => x.status === "active").length;
  const runningA = a.filter(
    (x) => x.state === "running" || x.state === "active" || x.state === "spawning",
  ).length;
  const queuedG = g.filter((x) => x.status === "queued").length;
  const runningG = g.filter((x) => x.status === "running" || x.status === "assigned").length;

  const summary = [
    style.bold(fg.cyan("Missions: ")) +
      String(m.length) +
      (activeM > 0 ? fg.green(" (" + activeM + " active)") : ""),
    style.bold(fg.cyan("Arms: ")) +
      String(a.length) +
      (runningA > 0 ? fg.green(" (" + runningA + " running)") : ""),
    style.bold(fg.cyan("Grips: ")) +
      String(g.length) +
      (queuedG > 0 ? fg.yellow(" (" + queuedG + " queued)") : "") +
      (runningG > 0 ? fg.green(" (" + runningG + " running)") : ""),
    style.bold(fg.cyan("Claims: ")) + String(c.length),
  ];
  lines.push(summary.join("   "));
  lines.push("");

  return lines;
}

function renderTabs(state: DashboardState, _cols: number): string {
  return TABS.map((t, i) => {
    const label = " " + (i + 1) + ":" + t.toUpperCase() + " ";
    return t === state.tab ? style.inverse(label) : fg.gray(label);
  }).join(fg.gray(" | "));
}

function renderMissionsTable(state: DashboardState, cols: number, maxRows: number): string[] {
  const lines: string[] = [];
  const header = padRight(
    fg.gray(
      padRight("MISSION_ID", 42) +
        padRight("TITLE", 35) +
        padRight("STATUS", 14) +
        padRight("ARMS", 6) +
        padRight("GRIPS", 6) +
        padRight("CREATED", 20),
    ),
    cols,
  );
  lines.push(header);
  lines.push(fg.gray(hr(cols, "\u2500")));

  if (state.missions.length === 0) {
    lines.push(
      fg.gray(
        '  No missions. Create one with: openclaw octo mission create --title "..." --grip <id>',
      ),
    );
    return lines;
  }

  const visible = state.missions.slice(0, maxRows);
  for (let i = 0; i < visible.length; i++) {
    const m = visible[i];
    const armCount = state.arms.filter((a) => a.mission_id === m.mission_id).length;
    const gripCount = state.grips.filter((g) => g.mission_id === m.mission_id).length;
    const created = new Date(m.created_at).toISOString().replace("T", " ").slice(0, 19);
    const prefix = i === state.selectedRow ? fg.cyan("\u25b6 ") : "  ";
    const line =
      prefix +
      padRight(fg.brightCyan(m.mission_id.slice(0, 38)), 42) +
      padRight(m.title.slice(0, 33), 35) +
      padRight(statusBadge(m.status), 24) + // wider to account for ANSI
      padRight(String(armCount), 6) +
      padRight(String(gripCount), 6) +
      fg.gray(created);
    lines.push(padRight(line, cols));
  }

  return lines;
}

function renderArmsTable(state: DashboardState, cols: number, maxRows: number): string[] {
  const lines: string[] = [];
  const header = padRight(
    fg.gray(
      padRight("ARM_ID", 42) +
        padRight("ADAPTER", 18) +
        padRight("RUNTIME", 16) +
        padRight("STATE", 14) +
        padRight("GRIP", 20) +
        padRight("RESTARTS", 10),
    ),
    cols,
  );
  lines.push(header);
  lines.push(fg.gray(hr(cols, "\u2500")));

  if (state.arms.length === 0) {
    lines.push(fg.gray("  No arms running."));
    return lines;
  }

  const visible = state.arms.slice(0, maxRows);
  for (let i = 0; i < visible.length; i++) {
    const a = visible[i];
    const prefix = i === state.selectedRow ? fg.cyan("\u25b6 ") : "  ";
    const line =
      prefix +
      padRight(fg.brightCyan(a.arm_id.slice(0, 38)), 42) +
      padRight(a.adapter_type, 18) +
      padRight(a.runtime_name.slice(0, 14), 16) +
      padRight(statusBadge(a.state), 24) +
      padRight(a.current_grip_id?.slice(0, 18) ?? fg.gray("-"), 20) +
      padRight(a.restart_count > 0 ? fg.yellow(String(a.restart_count)) : fg.gray("0"), 10);
    lines.push(padRight(line, cols));
  }

  return lines;
}

function renderGripsTable(state: DashboardState, cols: number, maxRows: number): string[] {
  const lines: string[] = [];
  const header = padRight(
    fg.gray(
      padRight("GRIP_ID", 30) +
        padRight("MISSION", 42) +
        padRight("STATUS", 14) +
        padRight("ARM", 20) +
        padRight("PRIORITY", 10),
    ),
    cols,
  );
  lines.push(header);
  lines.push(fg.gray(hr(cols, "\u2500")));

  if (state.grips.length === 0) {
    lines.push(fg.gray("  No grips."));
    return lines;
  }

  const visible = state.grips.slice(0, maxRows);
  for (let i = 0; i < visible.length; i++) {
    const g = visible[i];
    const prefix = i === state.selectedRow ? fg.cyan("\u25b6 ") : "  ";
    const line =
      prefix +
      padRight(fg.brightCyan(g.grip_id.slice(0, 28)), 30) +
      padRight(g.mission_id.slice(0, 38), 42) +
      padRight(statusBadge(g.status), 24) +
      padRight(g.assigned_arm_id?.slice(0, 18) ?? fg.gray("-"), 20) +
      padRight(String(g.priority), 10);
    lines.push(padRight(line, cols));
  }

  return lines;
}

function renderClaimsTable(state: DashboardState, cols: number, maxRows: number): string[] {
  const lines: string[] = [];
  const header = padRight(
    fg.gray(
      padRight("CLAIM_ID", 30) +
        padRight("TYPE", 14) +
        padRight("KEY", 30) +
        padRight("MODE", 14) +
        padRight("ARM", 20) +
        padRight("EXPIRES", 20),
    ),
    cols,
  );
  lines.push(header);
  lines.push(fg.gray(hr(cols, "\u2500")));

  if (state.claims.length === 0) {
    lines.push(fg.gray("  No active claims."));
    return lines;
  }

  const visible = state.claims.slice(0, maxRows);
  for (let i = 0; i < visible.length; i++) {
    const c = visible[i];
    const expires = new Date(c.lease_expiry_ts).toISOString().replace("T", " ").slice(0, 19);
    const prefix = i === state.selectedRow ? fg.cyan("\u25b6 ") : "  ";
    const modeColor = c.mode === "exclusive" ? fg.yellow : fg.green;
    const line =
      prefix +
      padRight(fg.brightCyan(c.claim_id.slice(0, 28)), 30) +
      padRight(c.resource_type, 14) +
      padRight(c.resource_key.slice(0, 28), 30) +
      padRight(modeColor(c.mode), 24) +
      padRight(c.owner_arm_id.slice(0, 18), 20) +
      fg.gray(expires);
    lines.push(padRight(line, cols));
  }

  return lines;
}

function renderEventsPanel(_state: DashboardState, cols: number, _maxRows: number): string[] {
  const lines: string[] = [];
  lines.push(fg.gray("  Event log tail — recent activity across all missions"));
  lines.push(fg.gray(hr(cols, "\u2500")));
  // TODO: wire to EventLogService when running with --probe
  lines.push(fg.gray("  (Event streaming will be available when missions are running)"));
  return lines;
}

function renderHelpOverlay(cols: number, _rows: number): string[] {
  const lines: string[] = [];
  const w = Math.min(50, cols - 4);
  lines.push("");
  lines.push(center(style.bold("Keyboard Shortcuts"), w));
  lines.push(center(hr(w, "\u2500"), w));
  lines.push(center("1-5       Switch tabs", w));
  lines.push(center("Tab       Next tab", w));
  lines.push(center("j/k       Navigate rows", w));
  lines.push(center("Enter     Show detail", w));
  lines.push(center("r         Refresh now", w));
  lines.push(center("?/h       Toggle help", w));
  lines.push(center("q/Ctrl-C  Quit", w));
  lines.push(center(hr(w, "\u2500"), w));
  return lines;
}

function renderFooter(cols: number): string {
  return fg.gray(padRight("  q:quit  1-5:tabs  j/k:navigate  r:refresh  ?:help", cols));
}

// ──────────────────────────────────────────────────────────────────────────
// Main render cycle
// ──────────────────────────────────────────────────────────────────────────

function render(state: DashboardState): void {
  const { rows, cols } = getTermSize();
  const output: string[] = [];

  output.push(CLEAR_SCREEN + CURSOR_HOME);

  // Header (4 lines)
  output.push(...renderHeader(state, cols));

  // Tabs (1 line)
  output.push(renderTabs(state, cols));
  output.push("");

  // Table area (rows - 8 for header/footer/tabs)
  const tableRows = rows - 8;

  if (state.showHelp) {
    output.push(...renderHelpOverlay(cols, tableRows));
  } else {
    switch (state.tab) {
      case "missions":
        output.push(...renderMissionsTable(state, cols, tableRows));
        break;
      case "arms":
        output.push(...renderArmsTable(state, cols, tableRows));
        break;
      case "grips":
        output.push(...renderGripsTable(state, cols, tableRows));
        break;
      case "claims":
        output.push(...renderClaimsTable(state, cols, tableRows));
        break;
      case "events":
        output.push(...renderEventsPanel(state, cols, tableRows));
        break;
    }
  }

  // Pad remaining rows
  while (output.length < rows - 1) {
    output.push("");
  }

  // Footer
  output.push(renderFooter(cols));

  process.stdout.write(output.join("\n"));
}

// ──────────────────────────────────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────────────────────────────────

export function runOctoTop(registry: RegistryService, opts: TopOptions = {}): Promise<number> {
  const refreshMs = opts.refreshMs ?? 2000;

  const state: DashboardState = {
    tab: "missions",
    selectedRow: 0,
    showHelp: false,
    missions: [],
    arms: [],
    grips: [],
    claims: [],
    lastRefresh: 0,
  };

  // Initial data load
  refreshData(registry, state);
  process.stdout.write(CURSOR_HIDE);
  render(state);

  // Refresh timer
  const timer = setInterval(() => {
    refreshData(registry, state);
    render(state);
  }, refreshMs);

  return new Promise<number>((resolve) => {
    const cleanup = startKeyListener((action: KeyAction) => {
      if (action === "quit") {
        clearInterval(timer);
        cleanup();
        process.stdout.write(CURSOR_SHOW + CLEAR_SCREEN + CURSOR_HOME);
        resolve(0);
        return;
      }

      if (action === "refresh") {
        refreshData(registry, state);
      } else if (action === "help") {
        state.showHelp = !state.showHelp;
      } else if (action === "tab" || action === "right") {
        const idx = TABS.indexOf(state.tab);
        state.tab = TABS[(idx + 1) % TABS.length];
        state.selectedRow = 0;
      } else if (action === "shift-tab" || action === "left") {
        const idx = TABS.indexOf(state.tab);
        state.tab = TABS[(idx - 1 + TABS.length) % TABS.length];
        state.selectedRow = 0;
      } else if (action === "down") {
        state.selectedRow++;
      } else if (action === "up") {
        state.selectedRow = Math.max(0, state.selectedRow - 1);
      } else if (typeof action === "object" && "tab" in action) {
        const tabIdx = action.tab - 1;
        if (tabIdx >= 0 && tabIdx < TABS.length) {
          state.tab = TABS[tabIdx];
          state.selectedRow = 0;
        }
      }

      render(state);
    });
  });
}
