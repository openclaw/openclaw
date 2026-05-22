import type { Command } from "commander";
import {
  resolveAgentIdByWorkspacePath,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import {
  installSkillFromClawHub,
  readTrackedClawHubSkillSlugs,
  searchSkillsFromClawHub,
  updateSkillsFromClawHub,
} from "../agents/skills-clawhub.js";
import {
  installSkillFromSource,
  isSkillSourceInstallSpec,
} from "../agents/skills-source-install.js";
import { getRuntimeConfig } from "../config/config.js";
import { defaultRuntime } from "../runtime.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { renderTable } from "../terminal/table.js";
import { getSkillUsage } from "../agents/skills/usage-tracker.js";
import type { SkillUsageEntry } from "../agents/skills/usage-tracker.js";
import { CONFIG_DIR } from "../utils.js";
import { resolveOptionFromCommand } from "./cli-utils.js";
import { formatSkillInfo, formatSkillsCheck, formatSkillsList } from "./skills-cli.format.js";

export type {
  SkillInfoOptions,
  SkillsCheckOptions,
  SkillsListOptions,
} from "./skills-cli.format.js";
export { formatSkillInfo, formatSkillsCheck, formatSkillsList } from "./skills-cli.format.js";

export type SkillsUsageOptions = {
  json?: boolean;
  since?: string; // e.g., "7d", "24h"
  agent?: string;
};

function parseSinceMs(since: string): number {
  const trimmed = since.trim().toLowerCase();
  const match = trimmed.match(/^(\d+)\s*(d|h|min|m|w)$/);
  if (!match) return 7 * 24 * 60 * 60 * 1000;
  const value = Number.parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case "w": return value * 7 * 24 * 60 * 60 * 1000;
    case "d": return value * 24 * 60 * 60 * 1000;
    case "h": return value * 60 * 60 * 1000;
    case "min": case "m": return value * 60 * 1000;
    default: return 7 * 24 * 60 * 60 * 1000;
  }
}

export function formatSkillsUsage(agentId: string, opts: SkillsUsageOptions): string {
  const data = getSkillUsage(agentId);
  const { skills } = data;
  const skillNames = Object.keys(skills);

  if (opts.json) return JSON.stringify(data, null, 2);
  if (skillNames.length === 0) return `No skill usage recorded for agent "${agentId}".`;

  const sinceMs = opts.since ? parseSinceMs(opts.since) : undefined;
  const cutoff = sinceMs !== undefined ? Date.now() - sinceMs : 0;

  const rows: Array<{ Skill: string; Calls: string; Time: string; Last: string }> = [];

  for (const name of skillNames) {
    const entry = skills[name] as SkillUsageEntry | undefined;
    if (!entry) continue;
    const filtered = sinceMs !== undefined
      ? entry.invocations.filter((inv) => new Date(inv.timestamp).getTime() >= cutoff)
      : entry.invocations;
    const count = filtered.length;
    if (count === 0) continue;

    const totalMs = filtered.reduce((sum, inv) => sum + (inv.durationMs || 0), 0);
    const time = totalMs >= 60_000 ? `${(totalMs / 60_000).toFixed(1)}min`
      : totalMs >= 1_000 ? `${(totalMs / 1_000).toFixed(1)}s` : `${totalMs}ms`;
    const ageMs = Date.now() - new Date(entry.lastUsed).getTime();
    const last = ageMs < 60_000 ? "just now"
      : ageMs < 3_600_000 ? `${Math.round(ageMs / 60_000)}m ago`
      : ageMs < 86_400_000 ? `${Math.round(ageMs / 3_600_000)}h ago`
      : `${Math.round(ageMs / 86_400_000)}d ago`;

    rows.push({ Skill: name, Calls: String(count), Time: time, Last: last });
  }

  if (rows.length === 0) {
    const label = opts.since ? ` (since ${opts.since})` : "";
    return `No skill usage recorded for agent "${agentId}"${label}.`;
  }

  rows.sort((a, b) => Number.parseInt(b.Calls, 10) - Number.parseInt(a.Calls, 10));

  const label = opts.since ? ` (since ${opts.since})` : "";
  const lines: string[] = [];
  lines.push(`${theme.heading("Skill Usage")} ${theme.muted(`\u2013 agent "${agentId}"${label}`)}`);
  lines.push("");
  lines.push(renderTable({
    width: 80,
    columns: [
      { key: "Skill", header: "Skill", minWidth: 20, flex: true },
      { key: "Calls", header: "Calls", minWidth: 8 },
      { key: "Time", header: "Total time", minWidth: 12 },
      { key: "Last", header: "Last used", minWidth: 14 },
    ],
    rows,
  }).trimEnd());
  return lines.join("\n");
}

type SkillStatusReport = Awaited<
  ReturnType<(typeof import("../agents/skills-status.js"))["buildWorkspaceSkillStatus"]>
>;

type ResolveSkillsWorkspaceOptions = {
  agentId?: string;
  cwd?: string;
};

function resolveSkillsWorkspace(options?: ResolveSkillsWorkspaceOptions): {
  config: ReturnType<typeof getRuntimeConfig>;
  workspaceDir: string;
  agentId: string;
} {
  const config = getRuntimeConfig();
  const explicitAgentId = normalizeOptionalString(options?.agentId);
  const inferredAgentId = explicitAgentId
    ? undefined
    : resolveAgentIdByWorkspacePath(config, options?.cwd ?? process.cwd());
  const agentId = explicitAgentId ?? inferredAgentId ?? resolveDefaultAgentId(config);
  return {
    config,
    agentId,
    workspaceDir: resolveAgentWorkspaceDir(config, agentId),
  };
}

function resolveAgentOption(
  command: Command | undefined,
  opts?: { agent?: string },
): string | undefined {
  return resolveOptionFromCommand<string>(command, "agent") ?? opts?.agent;
}

async function loadSkillsStatusReport(
  options?: ResolveSkillsWorkspaceOptions,
): Promise<SkillStatusReport> {
  const { config, workspaceDir, agentId } = resolveSkillsWorkspace(options);
  const { buildWorkspaceSkillStatus } = await import("../agents/skills-status.js");
  return buildWorkspaceSkillStatus(workspaceDir, { config, agentId });
}

async function runSkillsAction(
  render: (report: SkillStatusReport) => string,
  options?: ResolveSkillsWorkspaceOptions,
): Promise<void> {
  try {
    const report = await loadSkillsStatusReport(options);
    defaultRuntime.writeStdout(render(report));
    defaultRuntime.exit(0);
  } catch (err) {
    defaultRuntime.error(String(err));
    defaultRuntime.exit(1);
  }
}

function resolveActiveWorkspaceDir(options?: ResolveSkillsWorkspaceOptions): string {
  return resolveSkillsWorkspace(options).workspaceDir;
}

function resolveClawHubTargetWorkspaceDir(
  command: Command | undefined,
  opts: { agent?: string; global?: boolean },
): string | undefined {
  const agentId = resolveAgentOption(command, opts);
  if (opts.global && normalizeOptionalString(agentId)) {
    defaultRuntime.error("Use either --global or --agent, not both.");
    defaultRuntime.exit(1);
    return undefined;
  }
  if (opts.global) {
    return CONFIG_DIR;
  }
  return resolveActiveWorkspaceDir({ agentId });
}

/**
 * Register the skills CLI commands
 */
export function registerSkillsCli(program: Command) {
  const skills = program
    .command("skills")
    .description("List and inspect available skills")
    .option("--agent <id>", "Target agent workspace (defaults to cwd-inferred, then default agent)")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/skills", "docs.openclaw.ai/cli/skills")}\n`,
    );

  skills
    .command("search")
    .description("Search ClawHub skills")
    .argument("[query...]", "Optional search query")
    .option("--limit <n>", "Max results", (value) => Number.parseInt(value, 10))
    .option("--json", "Output as JSON", false)
    .action(async (queryParts: string[], opts: { limit?: number; json?: boolean }) => {
      try {
        const results = await searchSkillsFromClawHub({
          query: normalizeOptionalString(queryParts.join(" ")),
          limit: opts.limit,
        });
        if (opts.json) {
          defaultRuntime.writeJson({ results });
          return;
        }
        if (results.length === 0) {
          defaultRuntime.log("No ClawHub skills found.");
          return;
        }
        for (const entry of results) {
          const version = entry.version ? ` v${entry.version}` : "";
          const summary = entry.summary ? `  ${entry.summary}` : "";
          defaultRuntime.log(`${entry.slug}${version}  ${entry.displayName}${summary}`);
        }
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  skills
    .command("install")
    .description("Install a skill from ClawHub, git, or a local directory")
    .argument("<slug>", "ClawHub skill slug, git:<repo>, or local skill directory")
    .option("--version <version>", "Install a specific version")
    .option("--force", "Overwrite an existing workspace skill", false)
    .option("--global", "Install into the shared managed skills directory", false)
    .option("--agent <id>", "Target agent workspace (defaults to cwd-inferred, then default agent)")
    .option("--as <slug>", "Install a git/local skill under this slug")
    .action(
      async (
        slug: string,
        opts: {
          version?: string;
          force?: boolean;
          global?: boolean;
          agent?: string;
          as?: string;
        },
        command: Command,
      ) => {
        try {
          const workspaceDir = resolveClawHubTargetWorkspaceDir(command, opts);
          if (!workspaceDir) {
            return;
          }
          if (isSkillSourceInstallSpec(slug)) {
            if (opts.version) {
              defaultRuntime.error("--version is only supported for ClawHub skill installs.");
              defaultRuntime.exit(1);
              return;
            }
            const result = await installSkillFromSource({
              workspaceDir,
              spec: slug,
              slug: opts.as,
              force: Boolean(opts.force),
              logger: {
                info: (message) => defaultRuntime.log(message),
                warn: (message) => defaultRuntime.log(theme.warn(message)),
              },
            });
            if (!result.ok) {
              defaultRuntime.error(result.error);
              defaultRuntime.exit(1);
              return;
            }
            defaultRuntime.log(
              `Installed ${result.slug} from ${result.source} -> ${result.targetDir}`,
            );
            return;
          }
          if (opts.as) {
            defaultRuntime.error(
              "--as is only supported for git and local directory skill installs.",
            );
            defaultRuntime.exit(1);
            return;
          }
          const result = await installSkillFromClawHub({
            workspaceDir,
            slug,
            version: opts.version,
            force: Boolean(opts.force),
            logger: {
              info: (message) => defaultRuntime.log(message),
            },
          });
          if (!result.ok) {
            defaultRuntime.error(result.error);
            defaultRuntime.exit(1);
            return;
          }
          defaultRuntime.log(`Installed ${result.slug}@${result.version} -> ${result.targetDir}`);
        } catch (err) {
          defaultRuntime.error(String(err));
          defaultRuntime.exit(1);
        }
      },
    );

  skills
    .command("update")
    .description("Update ClawHub-installed skills in the active or shared managed directory")
    .argument("[slug]", "Single skill slug")
    .option("--all", "Update all tracked ClawHub skills", false)
    .option("--global", "Update skills in the shared managed skills directory", false)
    .option("--agent <id>", "Target agent workspace (defaults to cwd-inferred, then default agent)")
    .action(
      async (
        slug: string | undefined,
        opts: { all?: boolean; global?: boolean; agent?: string },
        command: Command,
      ) => {
        try {
          if (!slug && !opts.all) {
            defaultRuntime.error("Provide a skill slug or use --all.");
            defaultRuntime.exit(1);
            return;
          }
          if (slug && opts.all) {
            defaultRuntime.error("Use either a skill slug or --all.");
            defaultRuntime.exit(1);
            return;
          }
          const workspaceDir = resolveClawHubTargetWorkspaceDir(command, opts);
          if (!workspaceDir) {
            return;
          }
          const tracked = await readTrackedClawHubSkillSlugs(workspaceDir);
          if (opts.all && tracked.length === 0) {
            defaultRuntime.log("No tracked ClawHub skills to update.");
            return;
          }
          const results = await updateSkillsFromClawHub({
            workspaceDir,
            slug,
            logger: {
              info: (message) => defaultRuntime.log(message),
            },
          });
          for (const result of results) {
            if (!result.ok) {
              defaultRuntime.error(result.error);
              continue;
            }
            if (result.changed) {
              defaultRuntime.log(
                `Updated ${result.slug}: ${result.previousVersion ?? "unknown"} -> ${result.version}`,
              );
              continue;
            }
            defaultRuntime.log(`${result.slug} already at ${result.version}`);
          }
        } catch (err) {
          defaultRuntime.error(String(err));
          defaultRuntime.exit(1);
        }
      },
    );

  skills
    .command("list")
    .description("List all available skills")
    .option("--json", "Output as JSON", false)
    .option("--eligible", "Show only eligible (ready to use) skills", false)
    .option("-v, --verbose", "Show more details including missing requirements", false)
    .option("--agent <id>", "Target agent workspace (defaults to cwd-inferred, then default agent)")
    .action(
      async (
        opts: { json?: boolean; eligible?: boolean; verbose?: boolean; agent?: string },
        command: Command,
      ) => {
        await runSkillsAction((report) => formatSkillsList(report, opts), {
          agentId: resolveAgentOption(command, opts),
        });
      },
    );

  skills
    .command("info")
    .description("Show detailed information about a skill")
    .argument("<name>", "Skill name")
    .option("--json", "Output as JSON", false)
    .option("--agent <id>", "Target agent workspace (defaults to cwd-inferred, then default agent)")
    .action(async (name: string, opts: { json?: boolean; agent?: string }, command: Command) => {
      await runSkillsAction((report) => formatSkillInfo(report, name, opts), {
        agentId: resolveAgentOption(command, opts),
      });
    });

  skills
    .command("check")
    .description("Check which skills are ready, visible, or missing requirements")
    .option("--agent <id>", "Target agent workspace (defaults to cwd-inferred, then default agent)")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { json?: boolean; agent?: string }, command: Command) => {
      await runSkillsAction((report) => formatSkillsCheck(report, opts), {
        agentId: resolveAgentOption(command, opts),
      });
    });

  // Usage subcommand
  skills
    .command("usage")
    .description("Show skill usage telemetry")
    .option("--since <duration>", "Filter by time (e.g., 7d, 24h, 30min)", "7d")
    .option("--agent <id>", "Agent ID to query (default: default agent)")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { json?: boolean; since?: string; agent?: string }) => {
      try {
        const config = getRuntimeConfig();
        const agentId = opts.agent ?? resolveDefaultAgentId(config);
        defaultRuntime.log(formatSkillsUsage(agentId, opts as SkillsUsageOptions));
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  // Default action (no subcommand) - show list
  skills.action(async (opts: { agent?: string }, command: Command) => {
    await runSkillsAction((report) => formatSkillsList(report, {}), {
      agentId: resolveAgentOption(command, opts),
    });
  });
}
