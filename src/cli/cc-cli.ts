/**
 * `openclaw cc` — Claude Code session management CLI.
 *
 * Commands:
 *   list              List active/recent Claude Code sessions
 *   info <sessionId>  Show session summary
 *   attach <sessionId> Resume interactively in terminal (delegates to claude --resume)
 *   kill <sessionId>  Kill a running session
 *   costs             Cost summary across all CC sessions
 */

import { execSync } from "node:child_process";
import path from "node:path";
import type { Command } from "commander";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveClaudeBinary } from "../agents/claude-code/binary.js";
import {
  getAllLiveSessions,
  killClaudeCode,
  isClaudeCodeRunning,
} from "../agents/claude-code/live-state.js";
import { listAllSessions, listSessions } from "../agents/claude-code/sessions.js";
import type { ClaudeCodeSessionEntry } from "../agents/claude-code/types.js";
import { loadConfig } from "../config/config.js";
import { defaultRuntime } from "../runtime.js";

type CcListOptions = {
  json?: boolean;
  agent?: string;
  all?: boolean;
};

type CcInfoOptions = {
  json?: boolean;
};

type CcCostsOptions = {
  json?: boolean;
  since?: string;
  agent?: string;
};

function resolveAgent(agent?: string): string {
  if (agent?.trim()) {
    return agent.trim();
  }
  const cfg = loadConfig();
  return resolveDefaultAgentId(cfg);
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

function formatCost(usd: number): string {
  if (usd === 0) {
    return "$0.00";
  }
  if (usd < 0.01) {
    return `$${usd.toFixed(4)}`;
  }
  return `$${usd.toFixed(2)}`;
}

function formatSessionList(
  sessions: Array<ClaudeCodeSessionEntry & { agentId: string; repoPath: string }>,
  livePaths: Set<string>,
): string {
  if (sessions.length === 0) {
    return "No Claude Code sessions found.";
  }

  const lines: string[] = ["Claude Code Sessions:", ""];

  for (const s of sessions) {
    const running = livePaths.has(s.repoPath);
    const status = running ? " [RUNNING]" : "";
    const repo = path.basename(s.repoPath);
    const lastTask =
      s.taskHistory.length > 0
        ? s.taskHistory[s.taskHistory.length - 1].task.slice(0, 80)
        : "(no tasks)";

    lines.push(
      `  ${s.sessionId.slice(0, 12)}...  ${repo}${status}  ${formatCost(s.totalCostUsd)}  ${s.totalTurns} turns`,
    );
    lines.push(`    Last: ${lastTask}`);
    lines.push(`    Agent: ${s.agentId}  Updated: ${formatDate(s.lastResumedAt)}`);
    lines.push("");
  }

  return lines.join("\n");
}

function formatSessionInfo(
  sessionId: string,
  entry: ClaudeCodeSessionEntry & { repoPath: string },
  running: boolean,
): string {
  const lines: string[] = [
    `Session: ${entry.sessionId}`,
    `  Status:  ${running ? "RUNNING" : "idle"}`,
    `  Repo:    ${entry.repoPath}`,
    `  Created: ${formatDate(entry.createdAt)}`,
    `  Updated: ${formatDate(entry.lastResumedAt)}`,
    `  Cost:    ${formatCost(entry.totalCostUsd)}`,
    `  Turns:   ${entry.totalTurns}`,
    "",
    "Task History:",
  ];

  if (entry.taskHistory.length === 0) {
    lines.push("  (no tasks recorded)");
  } else {
    for (const t of entry.taskHistory) {
      lines.push(`  ${formatDate(t.at)}  ${formatCost(t.costUsd)}  ${t.task.slice(0, 100)}`);
    }
  }

  return lines.join("\n");
}

export function registerCcCli(program: Command) {
  const cc = program.command("cc").description("Claude Code session management");

  // -----------------------------------------------------------------------
  // cc list
  // -----------------------------------------------------------------------

  cc.command("list")
    .description("List active/recent Claude Code sessions")
    .option("--json", "Output as JSON", false)
    .option("--agent <id>", "Filter by agent ID")
    .option("--all", "Show all agents", false)
    .action((opts: CcListOptions) => {
      try {
        let sessions: Array<ClaudeCodeSessionEntry & { agentId: string; repoPath: string }>;
        if (opts.all) {
          sessions = listAllSessions();
        } else {
          const agentId = resolveAgent(opts.agent);
          const agentSessions = listSessions(agentId);
          sessions = Object.entries(agentSessions).map(([repoPath, entry]) => ({
            ...entry,
            agentId,
            repoPath,
          }));
        }

        // Sort by lastResumedAt descending
        sessions.sort(
          (a, b) => new Date(b.lastResumedAt).getTime() - new Date(a.lastResumedAt).getTime(),
        );

        // Get live sessions
        const live = getAllLiveSessions();
        const livePaths = new Set(live.keys());

        if (opts.json) {
          const output = sessions.map((s) => ({
            ...s,
            running: livePaths.has(s.repoPath),
          }));
          defaultRuntime.log(JSON.stringify(output, null, 2));
        } else {
          defaultRuntime.log(formatSessionList(sessions, livePaths));
        }
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  // -----------------------------------------------------------------------
  // cc info <sessionId>
  // -----------------------------------------------------------------------

  cc.command("info")
    .description("Show session summary")
    .argument("<sessionId>", "Session ID (partial match supported)")
    .option("--json", "Output as JSON", false)
    .action((sessionId: string, opts: CcInfoOptions) => {
      try {
        const allSessions = listAllSessions();
        const match = allSessions.find(
          (s) => s.sessionId === sessionId || s.sessionId.startsWith(sessionId),
        );

        if (!match) {
          defaultRuntime.error(`No session found matching: ${sessionId}`);
          defaultRuntime.exit(1);
          return;
        }

        const running = isClaudeCodeRunning(match.repoPath);

        if (opts.json) {
          defaultRuntime.log(JSON.stringify({ ...match, running }, null, 2));
        } else {
          defaultRuntime.log(formatSessionInfo(sessionId, match, running));
        }
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  // -----------------------------------------------------------------------
  // cc attach <sessionId>
  // -----------------------------------------------------------------------

  cc.command("attach")
    .description("Resume session interactively in terminal (delegates to claude --resume)")
    .argument("<sessionId>", "Session ID")
    .action((sessionId: string) => {
      try {
        const allSessions = listAllSessions();
        const match = allSessions.find(
          (s) => s.sessionId === sessionId || s.sessionId.startsWith(sessionId),
        );

        if (!match) {
          defaultRuntime.error(`No session found matching: ${sessionId}`);
          defaultRuntime.exit(1);
          return;
        }

        if (isClaudeCodeRunning(match.repoPath)) {
          defaultRuntime.error(
            `Session is currently running via OpenClaw. Kill it first with: openclaw cc kill ${sessionId}`,
          );
          defaultRuntime.exit(1);
          return;
        }

        const binary = resolveClaudeBinary();
        defaultRuntime.log(`Attaching to session ${match.sessionId} in ${match.repoPath}...`);
        defaultRuntime.log(
          `Running: ${binary} --resume ${match.sessionId} --cwd ${match.repoPath}\n`,
        );

        // Exec claude --resume — this replaces the current process
        execSync(`${binary} --resume ${match.sessionId}`, {
          cwd: match.repoPath,
          stdio: "inherit",
        });
      } catch (err) {
        if (err != null && typeof err === "object" && "status" in err) {
          // Normal exit from claude
          return;
        }
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  // -----------------------------------------------------------------------
  // cc kill <sessionId>
  // -----------------------------------------------------------------------

  cc.command("kill")
    .description("Kill a running Claude Code session")
    .argument("<sessionId>", "Session ID")
    .action((sessionId: string) => {
      try {
        const allSessions = listAllSessions();
        const match = allSessions.find(
          (s) => s.sessionId === sessionId || s.sessionId.startsWith(sessionId),
        );

        if (!match) {
          defaultRuntime.error(`No session found matching: ${sessionId}`);
          defaultRuntime.exit(1);
          return;
        }

        if (!isClaudeCodeRunning(match.repoPath)) {
          defaultRuntime.error(`Session ${match.sessionId} is not currently running.`);
          defaultRuntime.exit(1);
          return;
        }

        const killed = killClaudeCode(match.repoPath);
        if (killed) {
          defaultRuntime.log(
            `Killed session ${match.sessionId} on ${path.basename(match.repoPath)}.`,
          );
        } else {
          defaultRuntime.error("Failed to kill session.");
          defaultRuntime.exit(1);
        }
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  // -----------------------------------------------------------------------
  // cc costs
  // -----------------------------------------------------------------------

  cc.command("costs")
    .description("Cost summary across all Claude Code sessions")
    .option("--json", "Output as JSON", false)
    .option("--since <date>", "Filter by date (ISO format, e.g. 2026-02-01)")
    .option("--agent <id>", "Filter by agent ID")
    .action((opts: CcCostsOptions) => {
      try {
        let sessions = listAllSessions();

        // Filter by agent
        if (opts.agent) {
          const agentId = opts.agent.trim();
          sessions = sessions.filter((s) => s.agentId === agentId);
        }

        // Filter by date
        let sinceDate: Date | null = null;
        if (opts.since) {
          sinceDate = new Date(opts.since);
          if (Number.isNaN(sinceDate.getTime())) {
            defaultRuntime.error(`Invalid date: ${opts.since}`);
            defaultRuntime.exit(1);
            return;
          }
          sessions = sessions.filter(
            (s) => new Date(s.lastResumedAt).getTime() >= sinceDate!.getTime(),
          );
        }

        // Compute totals
        let totalCost = 0;
        let totalTurns = 0;
        let totalSessions = 0;
        const byRepo: Record<string, { cost: number; turns: number; sessions: number }> = {};
        const byAgent: Record<string, { cost: number; turns: number; sessions: number }> = {};

        for (const s of sessions) {
          totalCost += s.totalCostUsd;
          totalTurns += s.totalTurns;
          totalSessions += 1;

          const repoKey = path.basename(s.repoPath);
          if (!byRepo[repoKey]) {
            byRepo[repoKey] = { cost: 0, turns: 0, sessions: 0 };
          }
          byRepo[repoKey].cost += s.totalCostUsd;
          byRepo[repoKey].turns += s.totalTurns;
          byRepo[repoKey].sessions += 1;

          if (!byAgent[s.agentId]) {
            byAgent[s.agentId] = { cost: 0, turns: 0, sessions: 0 };
          }
          byAgent[s.agentId].cost += s.totalCostUsd;
          byAgent[s.agentId].turns += s.totalTurns;
          byAgent[s.agentId].sessions += 1;
        }

        if (opts.json) {
          defaultRuntime.log(
            JSON.stringify({ totalCost, totalTurns, totalSessions, byRepo, byAgent }, null, 2),
          );
          return;
        }

        const sinceText = sinceDate ? ` since ${opts.since}` : "";
        const lines: string[] = [
          `Claude Code Cost Summary${sinceText}`,
          "",
          `  Total:    ${formatCost(totalCost)}  (${totalTurns} turns, ${totalSessions} sessions)`,
          "",
        ];

        if (Object.keys(byRepo).length > 1) {
          lines.push("  By Repo:");
          for (const [repo, stats] of Object.entries(byRepo)) {
            lines.push(
              `    ${repo}: ${formatCost(stats.cost)}  (${stats.turns} turns, ${stats.sessions} sessions)`,
            );
          }
          lines.push("");
        }

        if (Object.keys(byAgent).length > 1) {
          lines.push("  By Agent:");
          for (const [agent, stats] of Object.entries(byAgent)) {
            lines.push(
              `    ${agent}: ${formatCost(stats.cost)}  (${stats.turns} turns, ${stats.sessions} sessions)`,
            );
          }
          lines.push("");
        }

        defaultRuntime.log(lines.join("\n"));
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });
}
