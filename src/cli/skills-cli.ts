import type { Command } from "commander";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
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

/** Hanzo canonical skills directory — single source of truth */
const HANZO_SKILLS_DIR = path.join(os.homedir(), ".hanzo", "skills");

/**
 * Agent directories that should receive symlinks from ~/.hanzo/skills/.
 * Each installed skill directory gets symlinked into every agent's global
 * skills folder so Claude Code, Cursor, Codex, Hanzo Bot, and Hanzo Bot
 * all see the same skills from one canonical location.
 */
const AGENT_SKILL_DIRS = [
  path.join(os.homedir(), ".claude", "skills"), // Claude Code
  path.join(os.homedir(), ".agents", "skills"), // Codex / Hanzo Bot / generic
  path.join(os.homedir(), ".cursor", "skills"), // Cursor
  path.join(os.homedir(), ".hanzo", "bot", "skills"), // Hanzo Bot legacy
];

/**
 * Normalize a GitHub URL or shorthand to a full HTTPS clone URL.
 * Accepts:
 *   github.com/org/repo
 *   https://github.com/org/repo
 *   https://github.com/org/repo.git
 *   org/repo (assumes GitHub)
 */
function normalizeGitUrl(input: string): string {
  let url = input.trim().replace(/\/+$/, "");
  if (url.startsWith("https://")) {
    url = url.slice("https://".length);
  } else if (url.startsWith("http://")) {
    url = url.slice("http://".length);
  }
  if (!url.includes(".") && url.split("/").length === 2) {
    url = `github.com/${url}`;
  }
  if (!url.endsWith(".git")) {
    url = `${url}.git`;
  }
  return `https://${url}`;
}

/**
 * Extract a human-readable name from a git URL for the skill directory.
 * e.g. "github.com/bootnode/skills" -> "bootnode-skills"
 */
function extractDirName(input: string): string {
  const parts = input
    .replace(/^https?:\/\//, "")
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[parts.length - 2]}-${parts[parts.length - 1]}`;
  }
  return parts[parts.length - 1] || "skills";
}

/**
 * Count SKILL.md files in a directory (direct children and one level deep).
 */
async function countSkills(dir: string): Promise<number> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  let count = 0;
  // Top-level SKILL.md
  if (entries.some((e) => e.isFile() && e.name === "SKILL.md")) {
    count += 1;
  }
  // Subdirectories with SKILL.md
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith(".")) {
      if (fs.existsSync(path.join(dir, entry.name, "SKILL.md"))) {
        count += 1;
      }
      // Also check skills/ subdirectory (common pattern: repo/skills/foo/SKILL.md)
      const skillsSubdir = path.join(dir, entry.name, "skills");
      if (fs.existsSync(skillsSubdir)) {
        try {
          const subEntries = await fs.promises.readdir(skillsSubdir, { withFileTypes: true });
          for (const sub of subEntries) {
            if (sub.isDirectory() && fs.existsSync(path.join(skillsSubdir, sub.name, "SKILL.md"))) {
              count += 1;
            }
          }
        } catch {
          /* ignore */
        }
      }
    }
  }
  // Also check repo/skills/ directly
  const repoSkillsDir = path.join(dir, "skills");
  if (fs.existsSync(repoSkillsDir) && fs.statSync(repoSkillsDir).isDirectory()) {
    try {
      const subEntries = await fs.promises.readdir(repoSkillsDir, { withFileTypes: true });
      for (const sub of subEntries) {
        if (
          sub.isDirectory() &&
          !sub.name.startsWith(".") &&
          fs.existsSync(path.join(repoSkillsDir, sub.name, "SKILL.md"))
        ) {
          count += 1;
        }
      }
    } catch {
      /* ignore */
    }
  }
  return count;
}

/**
 * Create symlinks from ~/.hanzo/skills/<name> into all agent skill directories.
 * If a symlink already exists and points to the right place, skip it.
 * If a real directory exists, skip it (don't clobber user's manual installs).
 */
async function symlinkToAgents(skillDirName: string): Promise<string[]> {
  const source = path.join(HANZO_SKILLS_DIR, skillDirName);
  const linked: string[] = [];

  for (const agentDir of AGENT_SKILL_DIRS) {
    const target = path.join(agentDir, skillDirName);

    try {
      // Create parent dir if needed
      await fs.promises.mkdir(agentDir, { recursive: true });

      // Check if target already exists
      try {
        const stat = await fs.promises.lstat(target);
        if (stat.isSymbolicLink()) {
          const existing = await fs.promises.readlink(target);
          if (existing === source) {
            linked.push(agentDir);
            continue; // Already correct
          }
          // Wrong target — remove and re-link
          await fs.promises.unlink(target);
        } else {
          // Real directory — don't clobber
          continue;
        }
      } catch {
        // Doesn't exist — good, we'll create it
      }

      await fs.promises.symlink(source, target, "dir");
      linked.push(agentDir);
    } catch {
      // Skip on permission errors etc.
    }
  }
  return linked;
}

/**
 * Remove symlinks from agent directories for a given skill dir name.
 */
async function unlinkFromAgents(skillDirName: string): Promise<void> {
  const source = path.join(HANZO_SKILLS_DIR, skillDirName);

  for (const agentDir of AGENT_SKILL_DIRS) {
    const target = path.join(agentDir, skillDirName);
    try {
      const stat = await fs.promises.lstat(target);
      if (stat.isSymbolicLink()) {
        const existing = await fs.promises.readlink(target);
        if (existing === source) {
          await fs.promises.unlink(target);
        }
      }
    } catch {
      // Doesn't exist or not a symlink — skip
    }
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
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/skills", "docs.hanzo.bot/cli/skills")}\n`,
    );

  skills
    .command("add")
    .description(
      "Add skills from a GitHub repository (installs to ~/.hanzo/skills/ and symlinks to all agents)",
    )
    .argument("<url>", "GitHub URL or shorthand (e.g. github.com/org/skills, org/skills)")
    .option("--yes", "Skip confirmation prompts", false)
    .option("--force", "Overwrite existing skills directory", false)
    .action(async (url, opts) => {
      try {
        const cloneUrl = normalizeGitUrl(url);
        const dirName = extractDirName(url);
        const targetDir = path.join(HANZO_SKILLS_DIR, dirName);

        defaultRuntime.log(`\n${theme.bold("Adding skills from:")} ${url}`);
        defaultRuntime.log(`${theme.muted("Clone URL:")} ${cloneUrl}`);
        defaultRuntime.log(`${theme.muted("Canonical:")} ${targetDir}\n`);

        // Create ~/.hanzo/skills/ if needed
        await fs.promises.mkdir(HANZO_SKILLS_DIR, { recursive: true });

        // Check if target already exists
        if (fs.existsSync(targetDir)) {
          if (opts.force) {
            defaultRuntime.log(`${theme.warning("Removing existing directory...")}`);
            await unlinkFromAgents(dirName);
            await fs.promises.rm(targetDir, { recursive: true, force: true });
          } else {
            // Try git pull instead
            defaultRuntime.log(`Directory already exists. Pulling latest changes...`);
            try {
              execSync("git pull --ff-only", { cwd: targetDir, stdio: "inherit" });
              const count = await countSkills(targetDir);
              defaultRuntime.log(`\n${theme.success("Skills updated successfully.")}`);
              defaultRuntime.log(`${theme.muted("Skills found:")} ${count}`);
              // Ensure symlinks are current
              const linked = await symlinkToAgents(dirName);
              if (linked.length > 0) {
                defaultRuntime.log(
                  `${theme.muted("Symlinked to:")} ${linked.length} agent directories`,
                );
              }
              defaultRuntime.log(
                `\n${theme.muted("Tip:")} Run ${theme.bold("bot skills list")} to see all available skills.\n`,
              );
              return;
            } catch {
              defaultRuntime.error(`Failed to update. Use --force to replace.`);
              defaultRuntime.exit(1);
              return;
            }
          }
        }

        // Clone the repository
        defaultRuntime.log(`Cloning skills repository...`);
        try {
          execSync(`git clone --depth 1 ${cloneUrl} ${targetDir}`, { stdio: "inherit" });
        } catch {
          defaultRuntime.error(`Failed to clone ${cloneUrl}`);
          defaultRuntime.error(`Make sure the repository exists and you have access.`);
          defaultRuntime.exit(1);
          return;
        }

        // Count skills
        const count = await countSkills(targetDir);

        // Symlink into all agent directories
        const linked = await symlinkToAgents(dirName);

        defaultRuntime.log(`\n${theme.success("Skills added successfully.")}`);
        defaultRuntime.log(`${theme.muted("Skills found:")} ${count}`);
        defaultRuntime.log(`${theme.muted("Canonical:")} ${targetDir}`);
        if (linked.length > 0) {
          defaultRuntime.log(theme.muted("Symlinked to:"));
          for (const dir of linked) {
            defaultRuntime.log(`  ${theme.muted("-")} ${dir}/${dirName}`);
          }
        }
        defaultRuntime.log(
          `\n${theme.muted("All agents (Claude Code, Cursor, Codex, Hanzo Bot, Hanzo Bot) now see these skills.")}`,
        );
        defaultRuntime.log(
          `${theme.muted("Tip:")} Run ${theme.bold("bot skills list")} to see all available skills.\n`,
        );
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  skills
    .command("remove")
    .description("Remove a previously added skills directory and its symlinks")
    .argument("<name>", "Skills directory name (e.g. bootnode-skills)")
    .option("--yes", "Skip confirmation prompts", false)
    .action(async (name, _opts) => {
      try {
        const targetDir = path.join(HANZO_SKILLS_DIR, name);

        if (!fs.existsSync(targetDir)) {
          defaultRuntime.error(`Skills directory not found: ${targetDir}`);
          // List what's available
          try {
            const entries = await fs.promises.readdir(HANZO_SKILLS_DIR, { withFileTypes: true });
            const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith("."));
            if (dirs.length > 0) {
              defaultRuntime.log(
                `\n${theme.muted("Available:")} ${dirs.map((d) => d.name).join(", ")}`,
              );
            }
          } catch {
            /* empty */
          }
          defaultRuntime.exit(1);
          return;
        }

        // Remove symlinks from all agent directories first
        await unlinkFromAgents(name);

        // Remove the canonical directory
        defaultRuntime.log(`Removing ${targetDir}...`);
        await fs.promises.rm(targetDir, { recursive: true, force: true });
        defaultRuntime.log(
          `${theme.success("Skills removed from ~/.hanzo/skills/ and all agent directories.")}\n`,
        );
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
      try {
        const config = loadConfig();
        const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
        const { buildWorkspaceSkillStatus } = await import("../agents/skills-status.js");
        const report = buildWorkspaceSkillStatus(workspaceDir, { config });
        defaultRuntime.log(formatSkillsList(report, opts));
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  skills
    .command("info")
    .description("Show detailed information about a skill")
    .argument("<name>", "Skill name")
    .option("--json", "Output as JSON", false)
    .action(async (name, opts) => {
      try {
        const config = loadConfig();
        const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
        const { buildWorkspaceSkillStatus } = await import("../agents/skills-status.js");
        const report = buildWorkspaceSkillStatus(workspaceDir, { config });
        defaultRuntime.log(formatSkillInfo(report, name, opts));
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  skills
    .command("check")
    .description("Check which skills are ready vs missing requirements")
    .option("--json", "Output as JSON", false)
    .action(async (opts) => {
      try {
        const config = loadConfig();
        const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
        const { buildWorkspaceSkillStatus } = await import("../agents/skills-status.js");
        const report = buildWorkspaceSkillStatus(workspaceDir, { config });
        defaultRuntime.log(formatSkillsCheck(report, opts));
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  // Default action (no subcommand) - show list
  skills.action(async () => {
    try {
      const config = loadConfig();
      const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
      const { buildWorkspaceSkillStatus } = await import("../agents/skills-status.js");
      const report = buildWorkspaceSkillStatus(workspaceDir, { config });
      defaultRuntime.log(formatSkillsList(report, {}));
    } catch (err) {
      defaultRuntime.error(String(err));
      defaultRuntime.exit(1);
    }
  });
}
