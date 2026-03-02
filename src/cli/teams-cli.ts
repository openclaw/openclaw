import type { Command } from "commander";
import { formatTimeAgo } from "../infra/format-time/format-relative.js";
import { defaultRuntime } from "../runtime.js";
import { renderTable } from "../terminal/table.js";
import { theme } from "../terminal/theme.js";
import { parseDurationMs } from "./parse-duration.js";

type TeamsListOptions = {
  state?: string;
  json?: boolean;
};

type TeamsShowOptions = {
  json?: boolean;
};

type TeamsCleanupOptions = {
  olderThan?: string;
  json?: boolean;
};

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function formatEpoch(epochMs: number): string {
  return formatTimeAgo(Date.now() - epochMs);
}

export function registerTeamsCli(program: Command) {
  const teams = program.command("teams").description("Manage team runs from the terminal");

  teams
    .command("list")
    .description("List team runs")
    .option("--state <state>", "Filter by state (active, completed, failed)")
    .option("--json", "Output JSON", false)
    .action(async (opts: TeamsListOptions) => {
      const { listTeamRuns } = await import("../teams/team-store.js");
      const filter: { state?: "active" | "completed" | "failed" } = {};
      if (opts.state) {
        const validStates = ["active", "completed", "failed"];
        if (!validStates.includes(opts.state)) {
          defaultRuntime.error(
            `Invalid state "${opts.state}". Must be one of: ${validStates.join(", ")}`,
          );
          process.exitCode = 1;
          return;
        }
        filter.state = opts.state as "active" | "completed" | "failed";
      }
      const runs = listTeamRuns(filter);

      if (opts.json) {
        defaultRuntime.log(JSON.stringify(runs, null, 2));
        return;
      }

      if (runs.length === 0) {
        defaultRuntime.log(theme.muted("No team runs found."));
        return;
      }

      const tableWidth = Math.max(60, (process.stdout.columns ?? 120) - 1);
      defaultRuntime.log(
        renderTable({
          width: tableWidth,
          columns: [
            { key: "ID", header: "ID", minWidth: 10 },
            { key: "Name", header: "Name", minWidth: 12, flex: true },
            { key: "Leader", header: "Leader", minWidth: 10 },
            { key: "Members", header: "Members", minWidth: 9 },
            { key: "State", header: "State", minWidth: 11 },
            { key: "Created", header: "Created", minWidth: 10 },
          ],
          rows: runs.map((run) => ({
            ID: shortId(run.id),
            Name: run.name,
            Leader: run.leader,
            Members: String(run.members.length),
            State: run.state,
            Created: formatEpoch(run.createdAt),
          })),
        }).trimEnd(),
      );
    });

  teams
    .command("show")
    .description("Show team run details")
    .argument("<id>", "Team run ID (or prefix)")
    .option("--json", "Output JSON", false)
    .action(async (idArg: string, opts: TeamsShowOptions) => {
      const { getTeamRun, listTeamRuns } = await import("../teams/team-store.js");
      const { listTeamTasks } = await import("../teams/team-task-store.js");
      const { listTeamMessages } = await import("../teams/team-message-store.js");

      const trimmed = idArg.trim();
      if (!trimmed) {
        defaultRuntime.error("Team run ID is required.");
        process.exitCode = 1;
        return;
      }

      // Try exact match first, then prefix match.
      let run = getTeamRun(trimmed);
      if (!run) {
        const all = listTeamRuns();
        const matches = all.filter((r) => r.id.startsWith(trimmed));
        if (matches.length === 1) {
          run = matches[0] ?? null;
        } else if (matches.length > 1) {
          defaultRuntime.error(
            `Ambiguous ID prefix "${trimmed}": matches ${matches.length} runs. Be more specific.`,
          );
          process.exitCode = 1;
          return;
        }
      }

      if (!run) {
        defaultRuntime.error(`Team run "${trimmed}" not found.`);
        process.exitCode = 1;
        return;
      }

      const tasks = listTeamTasks(run.id);
      const messages = listTeamMessages(run.id);

      if (opts.json) {
        defaultRuntime.log(JSON.stringify({ run, tasks, messages }, null, 2));
        return;
      }

      // Header
      const lines: string[] = [];
      lines.push(`${theme.heading("Team Run")} ${theme.muted(run.id)}`);
      lines.push(`  Name:    ${run.name}`);
      lines.push(`  Leader:  ${run.leader}`);
      lines.push(`  State:   ${run.state}`);
      lines.push(`  Created: ${formatEpoch(run.createdAt)}`);
      if (run.completedAt) {
        lines.push(`  Ended:   ${formatEpoch(run.completedAt)}`);
      }

      // Members
      lines.push("");
      lines.push(theme.heading("Members"));
      if (run.members.length === 0) {
        lines.push(theme.muted("  (none)"));
      } else {
        const tableWidth = Math.max(40, (process.stdout.columns ?? 120) - 1);
        lines.push(
          renderTable({
            width: tableWidth,
            columns: [
              { key: "Agent", header: "Agent", minWidth: 10, flex: true },
              { key: "Role", header: "Role", minWidth: 10 },
              { key: "State", header: "State", minWidth: 9 },
              { key: "Joined", header: "Joined", minWidth: 10 },
            ],
            rows: run.members.map((m) => ({
              Agent: m.agentId,
              Role: m.role ?? "",
              State: m.state,
              Joined: formatEpoch(m.joinedAt),
            })),
          }).trimEnd(),
        );
      }

      // Tasks
      lines.push("");
      lines.push(theme.heading("Tasks"));
      if (tasks.length === 0) {
        lines.push(theme.muted("  (none)"));
      } else {
        const tableWidth = Math.max(40, (process.stdout.columns ?? 120) - 1);
        lines.push(
          renderTable({
            width: tableWidth,
            columns: [
              { key: "Subject", header: "Subject", minWidth: 16, flex: true },
              { key: "Status", header: "Status", minWidth: 13 },
              { key: "Owner", header: "Owner", minWidth: 10 },
            ],
            rows: tasks.map((t) => ({
              Subject: t.subject,
              Status: t.status,
              Owner: t.owner ?? "(unassigned)",
            })),
          }).trimEnd(),
        );
      }

      // Recent messages (last 10)
      lines.push("");
      lines.push(theme.heading("Recent Messages"));
      if (messages.length === 0) {
        lines.push(theme.muted("  (none)"));
      } else {
        const recent = messages.slice(-10);
        for (const msg of recent) {
          const ts = formatEpoch(msg.timestamp);
          const direction = msg.to === "broadcast" ? "-> all" : `-> ${msg.to}`;
          lines.push(`  ${theme.muted(ts)} ${theme.info(msg.from)} ${theme.muted(direction)}`);
          // Truncate long messages to keep output readable.
          const content =
            msg.content.length > 120 ? `${msg.content.slice(0, 117)}...` : msg.content;
          lines.push(`    ${content}`);
        }
      }

      defaultRuntime.log(lines.join("\n"));
    });

  teams
    .command("cleanup")
    .description("Remove completed team runs older than a threshold")
    .option("--older-than <duration>", "Age threshold (e.g. 7d, 24h, 30m)", "7d")
    .option("--json", "Output JSON", false)
    .action(async (opts: TeamsCleanupOptions) => {
      const { loadTeamStore, saveTeamStore } = await import("../teams/team-store.js");

      let thresholdMs: number;
      try {
        thresholdMs = parseDurationMs(opts.olderThan ?? "7d", { defaultUnit: "d" });
      } catch {
        defaultRuntime.error(`Invalid duration: ${opts.olderThan}`);
        process.exitCode = 1;
        return;
      }

      const cutoff = Date.now() - thresholdMs;
      const store = loadTeamStore();
      const removedIds: string[] = [];

      for (const [id, run] of Object.entries(store.runs)) {
        // Only remove completed or failed runs that are older than the cutoff.
        if (run.state !== "active" && run.createdAt < cutoff) {
          removedIds.push(id);
        }
      }

      if (removedIds.length === 0) {
        if (opts.json) {
          defaultRuntime.log(JSON.stringify({ removed: [] }, null, 2));
        } else {
          defaultRuntime.log(theme.muted("No team runs to clean up."));
        }
        return;
      }

      // Remove runs and their associated tasks + messages.
      for (const id of removedIds) {
        delete store.runs[id];
        delete store.tasks[id];
        delete store.messages[id];
      }
      saveTeamStore(store);

      if (opts.json) {
        defaultRuntime.log(JSON.stringify({ removed: removedIds }, null, 2));
        return;
      }

      defaultRuntime.log(
        `${theme.success("Cleaned up")} ${removedIds.length} team run${removedIds.length === 1 ? "" : "s"} older than ${opts.olderThan ?? "7d"}.`,
      );
    });

  // Default action (no subcommand) - show list
  teams.action(async () => {
    const { listTeamRuns } = await import("../teams/team-store.js");
    const runs = listTeamRuns();

    if (runs.length === 0) {
      defaultRuntime.log(theme.muted("No team runs found."));
      return;
    }

    const tableWidth = Math.max(60, (process.stdout.columns ?? 120) - 1);
    defaultRuntime.log(
      renderTable({
        width: tableWidth,
        columns: [
          { key: "ID", header: "ID", minWidth: 10 },
          { key: "Name", header: "Name", minWidth: 12, flex: true },
          { key: "Leader", header: "Leader", minWidth: 10 },
          { key: "Members", header: "Members", minWidth: 9 },
          { key: "State", header: "State", minWidth: 11 },
          { key: "Created", header: "Created", minWidth: 10 },
        ],
        rows: runs.map((run) => ({
          ID: shortId(run.id),
          Name: run.name,
          Leader: run.leader,
          Members: String(run.members.length),
          State: run.state,
          Created: formatEpoch(run.createdAt),
        })),
      }).trimEnd(),
    );
  });
}
