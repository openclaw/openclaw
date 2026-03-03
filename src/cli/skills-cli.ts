import type { Command } from "commander";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadConfig, readConfigFileSnapshot, writeConfigFile } from "../config/config.js";
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

function normalizeSkillType(raw: string): "default" | "optional" | null {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "default" || normalized === "optional") {
    return normalized;
  }
  return null;
}

function normalizeListType(raw: unknown): "all" | "default" | "optional" | null {
  if (raw === undefined) {
    return "all";
  }
  if (typeof raw !== "string") {
    return null;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "all" || normalized === "default" || normalized === "optional") {
    return normalized;
  }
  return null;
}

async function runSkillsClassifyAction(params: {
  name: string;
  type: string;
  json: boolean;
}): Promise<void> {
  try {
    const targetType = normalizeSkillType(params.type);
    if (!targetType) {
      defaultRuntime.error('Invalid type. Use "default" or "optional".');
      defaultRuntime.exit(1);
      return;
    }

    const report = await loadSkillsStatusReport();
    const resolvedName = params.name.trim();
    const matched = report.skills.find(
      (skill) => skill.name === resolvedName || skill.skillKey === resolvedName,
    );
    if (!matched) {
      defaultRuntime.error(
        `Skill "${params.name}" not found. Run \`openclaw skills list\` to see available skills.`,
      );
      defaultRuntime.exit(1);
      return;
    }

    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid) {
      defaultRuntime.error(`Config invalid at ${snapshot.path}.`);
      for (const issue of snapshot.issues) {
        defaultRuntime.error(`- ${issue.path || "<root>"}: ${issue.message}`);
      }
      defaultRuntime.exit(1);
      return;
    }

    const next = structuredClone(snapshot.resolved) as Record<string, unknown>;
    const nextAgents =
      next.agents && typeof next.agents === "object"
        ? (next.agents as Record<string, unknown>)
        : {};
    const nextDefaults =
      nextAgents.defaults && typeof nextAgents.defaults === "object"
        ? (nextAgents.defaults as Record<string, unknown>)
        : {};
    const currentSkills = Array.isArray(nextDefaults.skills)
      ? nextDefaults.skills.map((entry) => String(entry).trim()).filter(Boolean)
      : [];
    const deduped = Array.from(new Set(currentSkills));

    const nextDefaultSkills =
      targetType === "default"
        ? deduped.includes(matched.name)
          ? deduped
          : [...deduped, matched.name]
        : deduped.filter((name) => name !== matched.name);

    nextDefaults.skills = nextDefaultSkills;
    nextAgents.defaults = nextDefaults;
    next.agents = nextAgents;

    await writeConfigFile(next);

    if (params.json) {
      defaultRuntime.log(
        JSON.stringify(
          {
            skill: matched.name,
            type: targetType,
            defaultSkills: nextDefaultSkills,
          },
          null,
          2,
        ),
      );
      return;
    }

    defaultRuntime.log(
      `Updated skill type: ${matched.name} -> ${targetType}. Restart the gateway to apply.`,
    );
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
    .option("--type <type>", "Filter by type: all | default | optional", "all")
    .option("-v, --verbose", "Show more details including missing requirements", false)
    .action(async (opts) => {
      const listType = normalizeListType(opts.type);
      if (!listType) {
        defaultRuntime.error('Invalid --type value. Use "all", "default", or "optional".');
        defaultRuntime.exit(1);
        return;
      }
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
    .command("classify")
    .description("Set skill type (default or optional)")
    .argument("<name>", "Skill name")
    .argument("<type>", "Type: default | optional")
    .option("--json", "Output as JSON", false)
    .action(async (name: string, type: string, opts) => {
      await runSkillsClassifyAction({
        name,
        type,
        json: Boolean(opts.json),
      });
    });

  // Default action (no subcommand) - show list
  skills.action(async () => {
    await runSkillsAction((report) => formatSkillsList(report, {}));
  });
}
