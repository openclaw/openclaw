import type { Command } from "commander";
import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
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

function resolveSkillsAgentId(config: ReturnType<typeof loadConfig>, rawAgentId?: string): string {
  const trimmed = rawAgentId?.trim();
  if (!trimmed) {
    return resolveDefaultAgentId(config);
  }
  const agentId = normalizeAgentId(trimmed);
  if (agentId === DEFAULT_AGENT_ID && trimmed.toLowerCase() !== DEFAULT_AGENT_ID) {
    throw new Error(
      `Invalid agent id "${trimmed}". Use "openclaw agents list" to see configured agents.`,
    );
  }
  const knownAgents = listAgentIds(config);
  if (!knownAgents.includes(agentId)) {
    throw new Error(
      `Unknown agent id "${trimmed}". Use "openclaw agents list" to see configured agents.`,
    );
  }
  return agentId;
}

async function loadSkillsStatusReport(rawAgentId?: string): Promise<SkillStatusReport> {
  const config = loadConfig();
  const agentId = resolveSkillsAgentId(config, rawAgentId);
  const workspaceDir = resolveAgentWorkspaceDir(config, agentId);
  const { buildWorkspaceSkillStatus } = await import("../agents/skills-status.js");
  return buildWorkspaceSkillStatus(workspaceDir, { config });
}

async function runSkillsAction(
  render: (report: SkillStatusReport) => string,
  rawAgentId?: string,
): Promise<void> {
  try {
    const report = await loadSkillsStatusReport(rawAgentId);
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
    .option("--agent <id>", "Agent id (default: configured default agent)")
    .option("--json", "Output as JSON", false)
    .option("--eligible", "Show only eligible (ready to use) skills", false)
    .option("-v, --verbose", "Show more details including missing requirements", false)
    .action(async (opts) => {
      await runSkillsAction((report) => formatSkillsList(report, opts), opts.agent);
    });

  skills
    .command("info")
    .description("Show detailed information about a skill")
    .argument("<name>", "Skill name")
    .option("--agent <id>", "Agent id (default: configured default agent)")
    .option("--json", "Output as JSON", false)
    .action(async (name, opts) => {
      await runSkillsAction((report) => formatSkillInfo(report, name, opts), opts.agent);
    });

  skills
    .command("check")
    .description("Check which skills are ready vs missing requirements")
    .option("--agent <id>", "Agent id (default: configured default agent)")
    .option("--json", "Output as JSON", false)
    .action(async (opts) => {
      await runSkillsAction((report) => formatSkillsCheck(report, opts), opts.agent);
    });

  // Default action (no subcommand) - show list
  skills.action(async () => {
    await runSkillsAction((report) => formatSkillsList(report, {}));
  });
}
