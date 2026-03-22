import type { Command } from "commander";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import {
  installSkillFromClawHub,
  readTrackedClawHubSkillSlugs,
  searchSkillsFromClawHub,
  updateSkillsFromClawHub,
} from "../agents/skills-clawhub.js";
import { loadConfig } from "../config/config.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { formatSkillInfo, formatSkillsCheck, formatSkillsList } from "./skills-cli.format.js";

export type {
  SkillInfoOptions,
  SkillsCheckOptions,
  SkillsListOptions,
} from "./skills-cli.format.js";
export { formatSkillInfo, formatSkillsCheck, formatSkillsList } from "./skills-cli.format.js";

type SkillStatusReport = Awaited<
  ReturnType<(typeof import("../agents/skills-status.js"))["buildWorkspaceSkillStatus"]>
>;

async function loadSkillsStatusReport(): Promise<SkillStatusReport> {
  const config = loadConfig();
  const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
  const { buildWorkspaceSkillStatus } = await import("../agents/skills-status.js");
  return buildWorkspaceSkillStatus(workspaceDir, { config });
}

async function runSkillsAction(render: (report: SkillStatusReport) => string): Promise<void> {
  try {
    const report = await loadSkillsStatusReport();
    defaultRuntime.log(render(report));
  } catch (err) {
    defaultRuntime.error(String(err));
    defaultRuntime.exit(1);
  }
}

function resolveActiveWorkspaceDir(): string {
  const config = loadConfig();
  return resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
}

/**
 * Register the skills CLI commands
 */
export function registerSkillsCli(program: Command) {
  const skills = program
    .command("skills")
    .description("List and inspect available skills")
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
          query: queryParts.join(" ").trim() || undefined,
          limit: opts.limit,
        });
        if (opts.json) {
          defaultRuntime.log(JSON.stringify({ results }, null, 2));
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
    .description("Install a skill from ClawHub into the active workspace")
    .argument("<slug>", "ClawHub skill slug")
    .option("--version <version>", "Install a specific version")
    .option("--force", "Overwrite an existing workspace skill", false)
    .action(async (slug: string, opts: { version?: string; force?: boolean }) => {
      try {
        const workspaceDir = resolveActiveWorkspaceDir();
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
    });

  skills
    .command("update")
    .description("Update ClawHub-installed skills in the active workspace")
    .argument("[slug]", "Single skill slug")
    .option("--all", "Update all tracked ClawHub skills", false)
    .action(async (slug: string | undefined, opts: { all?: boolean }) => {
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
        const workspaceDir = resolveActiveWorkspaceDir();
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
    });

  skills
    .command("list")
    .description("List all available skills")
    .option("--json", "Output as JSON", false)
    .option("--eligible", "Show only eligible (ready to use) skills", false)
    .option("-v, --verbose", "Show more details including missing requirements", false)
    .action(async (opts) => {
      await runSkillsAction((report) => formatSkillsList(report, opts));
    });

  skills
    .command("info")
    .description("Show detailed information about a skill")
    .argument("<name>", "Skill name")
    .option("--json", "Output as JSON", false)
    .action(async (name, opts) => {
      await runSkillsAction((report) => formatSkillInfo(report, name, opts));
    });

  skills
    .command("check")
    .description("Check which skills are ready vs missing requirements")
    .option("--json", "Output as JSON", false)
    .action(async (opts) => {
      await runSkillsAction((report) => formatSkillsCheck(report, opts));
    });

  // Default action (no subcommand) - show list
  skills.action(async () => {
    await runSkillsAction((report) => formatSkillsList(report, {}));
  });
}
