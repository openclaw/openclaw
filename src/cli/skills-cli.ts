import type { Command } from "commander";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import { defaultRuntime } from "../runtime.js";
import type { SkillSecurityVerdictExplainability } from "../security/skill-verdict.js";
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

async function runSkillsAction(
  render: (report: SkillStatusReport) => string | Promise<string>,
): Promise<void> {
  try {
    const report = await loadSkillsStatusReport();
    defaultRuntime.log(await render(report));
  } catch (err) {
    defaultRuntime.error(String(err));
    defaultRuntime.exit(1);
  }
}

function findSkillByName(report: SkillStatusReport, skillName: string) {
  return report.skills.find((skill) => skill.name === skillName || skill.skillKey === skillName);
}

async function loadSkillSecurityVerdict(
  report: SkillStatusReport,
  skillName: string,
): Promise<{
  verdict?: SkillSecurityVerdictExplainability;
  verdictError?: string;
}> {
  const skill = findSkillByName(report, skillName);
  if (!skill) {
    return {};
  }
  try {
    const { buildSkillSecurityVerdictExplainability } =
      await import("../security/skill-verdict.js");
    return {
      verdict: await buildSkillSecurityVerdictExplainability({
        skillKey: skill.skillKey,
        skillName: skill.name,
        skillDir: skill.baseDir,
      }),
    };
  } catch (err) {
    return {
      verdictError: err instanceof Error ? err.message : String(err),
    };
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
    .alias("inspect")
    .description("Show detailed information about a skill")
    .argument("<name>", "Skill name")
    .option("--json", "Output as JSON", false)
    .action(async (name, opts) => {
      await runSkillsAction(async (report) => {
        const security = await loadSkillSecurityVerdict(report, name);
        return formatSkillInfo(report, name, opts, security.verdict, security.verdictError);
      });
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
