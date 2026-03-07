import type { Command } from "commander";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { formatCliCommand } from "./command-format.js";
import { createCliProgress } from "./progress.js";
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

  skills
    .command("install")
    .description("Install dependencies for a skill")
    .argument("<name>", "Skill name")
    .option("--install-id <id>", "Specific installer ID (default: auto-select best)")
    .option("--timeout <ms>", "Timeout in milliseconds", "300000")
    .action(async (name: string, opts: { installId?: string; timeout: string }) => {
      try {
        const config = loadConfig();
        const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
        const { buildWorkspaceSkillStatus } = await import("../agents/skills-status.js");
        const report = await buildWorkspaceSkillStatus(workspaceDir, { config });
        const skill = report.skills.find((s) => s.name === name);
        if (!skill) {
          defaultRuntime.error(`Skill not found: ${name}`);
          defaultRuntime.exit(1);
          return;
        }
        const installId = opts.installId ?? skill.install[0]?.id;
        if (!installId) {
          defaultRuntime.error(`No install options available for skill: ${name}`);
          defaultRuntime.exit(1);
          return;
        }

        const progress = createCliProgress({ label: `Installing ${name}…`, indeterminate: true });
        const { installSkill } = await import("../agents/skills-install.js");
        const result = await installSkill({
          workspaceDir,
          skillName: name,
          installId,
          timeoutMs: Number(opts.timeout),
          config,
        });
        const warnings = result.warnings ?? [];

        if (result.ok) {
          progress.done();
          defaultRuntime.log(
            warnings.length > 0
              ? theme.success(`Installed ${name} (with warnings)`)
              : theme.success(`Installed ${name}`),
          );
          for (const warning of warnings) {
            defaultRuntime.log(warning);
          }
          return;
        }

        progress.done();
        const code = result.code == null ? "" : ` (exit ${result.code})`;
        defaultRuntime.error(`Install failed: ${name}${code}`);
        for (const warning of warnings) {
          defaultRuntime.log(warning);
        }
        if (result.stderr) {
          defaultRuntime.log(result.stderr.trim());
        } else if (result.stdout) {
          defaultRuntime.log(result.stdout.trim());
        }
        defaultRuntime.log(
          `Tip: run \`${formatCliCommand("openclaw doctor")}\` to review skills + requirements.`,
        );
        defaultRuntime.exit(1);
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  // Default action (no subcommand) - show list
  skills.action(async () => {
    await runSkillsAction((report) => formatSkillsList(report, {}));
  });
}
