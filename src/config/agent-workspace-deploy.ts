/**
 * Agent Workspace Deploy Engine.
 *
 * Deploys agent blueprints (agents/{id}/) into workspace instances
 * (~/.openclaw/workspace-{id}/). Generates workspace files from
 * AGENT.md + agent.yaml manifest, tracks deployed version, and
 * handles version-managed upgrades.
 *
 * File categories:
 * - OVERWRITE-SAFE: SOUL.md, IDENTITY.md, TOOLS.md — regenerated on deploy/upgrade
 * - TEMPLATE-ONLY: HEARTBEAT.md, AGENTS.md, BOOTSTRAP.md — seeded once, never overwritten
 * - NEVER-TOUCH: memory.md, MEMORY.md, USER.md — user-owned, never modified by deploy
 */
import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentManifest } from "./zod-schema.agent-manifest.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface DeployResult {
  agentId: string;
  workspaceDir: string;
  version: string;
  previousVersion: string | null;
  filesWritten: string[];
  filesSkipped: string[];
  isUpgrade: boolean;
  isFirstDeploy: boolean;
}

export interface DeployOptions {
  /** Force overwrite even if version matches. */
  force?: boolean;
  /** Dry run — don't write files, just report what would change. */
  dryRun?: boolean;
}

interface AgentBlueprint {
  manifest: AgentManifest;
  agentMd: string | null;
  blueprintDir: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const VERSION_FILE = ".agent-version";

/** Files regenerated on every deploy/upgrade from blueprint. */
const OVERWRITE_SAFE_FILES = ["SOUL.md", "IDENTITY.md", "TOOLS.md"] as const;

/** Files seeded once on first deploy, never overwritten. */
const TEMPLATE_ONLY_FILES = ["HEARTBEAT.md", "AGENTS.md"] as const;

/** Files never touched by the deploy engine. */
const NEVER_TOUCH_FILES = ["memory.md", "MEMORY.md", "USER.md", "BOOTSTRAP.md"] as const;

// ── Blueprint loading ────────────────────────────────────────────────────────

/**
 * Load an agent blueprint from the bundled agents directory.
 */
export async function loadBlueprint(blueprintDir: string): Promise<AgentBlueprint | null> {
  try {
    const yamlPath = join(blueprintDir, "agent.yaml");
    const { parse: parseYaml } = await import("yaml");
    const { AgentManifestSchema } = await import("./zod-schema.agent-manifest.js");

    const yamlContent = await readFile(yamlPath, "utf-8");
    const parsed = parseYaml(yamlContent);
    const result = AgentManifestSchema.safeParse(parsed);
    if (!result.success) {
      return null;
    }

    let agentMd: string | null = null;
    try {
      agentMd = await readFile(join(blueprintDir, "AGENT.md"), "utf-8");
    } catch {
      // AGENT.md is optional (bundles don't have it)
    }

    return {
      manifest: result.data,
      agentMd,
      blueprintDir,
    };
  } catch {
    return null;
  }
}

// ── File generators ──────────────────────────────────────────────────────────

/**
 * Generate SOUL.md content from AGENT.md blueprint.
 * AGENT.md is the design-time description; SOUL.md is the runtime personality.
 */
export function generateSoulMd(manifest: AgentManifest, agentMd: string | null): string {
  if (agentMd) {
    // Use AGENT.md as the base for SOUL.md
    return agentMd;
  }

  // Fallback: generate minimal SOUL.md from manifest
  const lines = [`# ${manifest.name} — ${manifest.role}`, "", manifest.description, ""];

  if (manifest.capabilities?.length) {
    lines.push("## Capabilities", "");
    for (const cap of manifest.capabilities) {
      lines.push(`- ${cap.replace(/_/g, " ")}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Generate IDENTITY.md from manifest fields.
 */
export function generateIdentityMd(manifest: AgentManifest): string {
  const lines = [
    `# IDENTITY.md — ${manifest.name}`,
    "",
    `- **Name:** ${manifest.name}`,
    `- **Role:** ${manifest.role}`,
    `- **Department:** ${manifest.department}`,
  ];

  if (manifest.identity?.emoji) {
    lines.push(`- **Emoji:** ${manifest.identity.emoji}`);
  }

  if (manifest.requires) {
    lines.push(`- **Reports to:** ${manifest.requires}`);
  }

  lines.push("", "---", "");
  lines.push(manifest.description);
  lines.push("");

  return lines.join("\n");
}

/**
 * Generate TOOLS.md from manifest tools config.
 */
export function generateToolsMd(manifest: AgentManifest): string {
  const lines = [`# TOOLS.md — ${manifest.name}`, ""];

  if (manifest.tools?.allow?.length) {
    lines.push("## Allowed Tools", "");
    for (const tool of manifest.tools.allow) {
      lines.push(`- ${tool}`);
    }
    lines.push("");
  }

  if (manifest.tools?.deny?.length) {
    lines.push("## Denied Tools", "");
    for (const tool of manifest.tools.deny) {
      lines.push(`- ${tool}`);
    }
    lines.push("");
  }

  if (manifest.skills?.length) {
    lines.push("## Skills", "");
    for (const skill of manifest.skills) {
      lines.push(`- ${skill}`);
    }
    lines.push("");
  }

  if (manifest.routing_hints?.keywords?.length) {
    lines.push("## Routing Keywords", "");
    lines.push(manifest.routing_hints.keywords.join(", "));
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Generate HEARTBEAT.md template (only for first deploy).
 */
export function generateHeartbeatMd(manifest: AgentManifest): string {
  return [
    `# HEARTBEAT.md — ${manifest.name}`,
    "",
    "Lightweight context for heartbeat/cron runs.",
    "",
    "## Quick Status",
    "",
    "_Update this with current priorities and status notes._",
    "",
  ].join("\n");
}

// ── Version tracking ─────────────────────────────────────────────────────────

/**
 * Read the deployed version from workspace.
 */
export async function readDeployedVersion(workspaceDir: string): Promise<string | null> {
  try {
    const content = await readFile(join(workspaceDir, VERSION_FILE), "utf-8");
    return content.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Write the deployed version to workspace.
 */
async function writeDeployedVersion(workspaceDir: string, version: string): Promise<void> {
  await writeFile(join(workspaceDir, VERSION_FILE), version + "\n", "utf-8");
}

// ── Matrix template integration ─────────────────────────────────────────────

/**
 * Check if a matrix template exists for this agent and load a specific file.
 * Matrix templates override generated content when available.
 */
async function loadMatrixTemplateFile(
  agentId: string,
  fileName: string,
  templateBaseDir?: string,
): Promise<string | null> {
  // Try to find the matrix template directory
  const searchDirs = templateBaseDir
    ? [join(templateBaseDir, "matrix", agentId)]
    : [
        // Standard locations
        join(process.cwd(), "docs", "reference", "templates", "matrix", agentId),
      ];

  for (const dir of searchDirs) {
    try {
      const content = await readFile(join(dir, fileName), "utf-8");
      // Strip YAML frontmatter (same as workspace template loading)
      return stripFrontmatter(content);
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Strip YAML frontmatter from markdown content.
 */
function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) {
    return content;
  }
  const endIdx = content.indexOf("---", 3);
  if (endIdx === -1) {
    return content;
  }
  return content.slice(endIdx + 3).trimStart();
}

// ── Deploy engine ────────────────────────────────────────────────────────────

/**
 * Deploy an agent blueprint to a workspace directory.
 *
 * This is the main entry point. It:
 * 1. Loads the blueprint from agents/{id}/
 * 2. Checks deployed version vs manifest version
 * 3. Generates workspace files from blueprint
 * 4. Writes overwrite-safe files (always)
 * 5. Seeds template-only files (first deploy only)
 * 6. Never touches user-owned files
 * 7. Updates .agent-version
 */
export async function deployAgent(
  blueprint: AgentBlueprint,
  workspaceDir: string,
  opts: DeployOptions = {},
  templateBaseDir?: string,
): Promise<DeployResult> {
  const { manifest, agentMd } = blueprint;
  const { force = false, dryRun = false } = opts;

  const previousVersion = await readDeployedVersion(workspaceDir);
  const isFirstDeploy = previousVersion === null;
  const isUpgrade = !isFirstDeploy && previousVersion !== manifest.version;
  const needsDeploy = isFirstDeploy || isUpgrade || force;

  const result: DeployResult = {
    agentId: manifest.id,
    workspaceDir,
    version: manifest.version,
    previousVersion,
    filesWritten: [],
    filesSkipped: [],
    isUpgrade,
    isFirstDeploy,
  };

  if (!needsDeploy) {
    // Version matches, nothing to do
    result.filesSkipped.push(...OVERWRITE_SAFE_FILES, ...TEMPLATE_ONLY_FILES);
    return result;
  }

  // Ensure workspace directory exists
  if (!dryRun) {
    await mkdir(workspaceDir, { recursive: true });
  }

  // Generate overwrite-safe files (always written on deploy)
  const overwrites: Record<string, () => string | Promise<string>> = {
    "SOUL.md": () => generateSoulMd(manifest, agentMd),
    "IDENTITY.md": () => generateIdentityMd(manifest),
    "TOOLS.md": () => generateToolsMd(manifest),
  };

  for (const [fileName, generator] of Object.entries(overwrites)) {
    // Check for matrix template override first
    const matrixContent = await loadMatrixTemplateFile(manifest.id, fileName, templateBaseDir);
    const content = matrixContent ?? (await generator());

    if (!dryRun) {
      await writeFile(join(workspaceDir, fileName), content, "utf-8");
    }
    result.filesWritten.push(fileName);
  }

  // Seed template-only files (first deploy only)
  if (isFirstDeploy) {
    for (const fileName of TEMPLATE_ONLY_FILES) {
      const exists = await fileExists(join(workspaceDir, fileName));
      if (exists) {
        result.filesSkipped.push(fileName);
        continue;
      }

      // Check matrix template first, then generate
      const matrixContent = await loadMatrixTemplateFile(manifest.id, fileName, templateBaseDir);
      let content: string | null = matrixContent;

      if (!content && fileName === "HEARTBEAT.md") {
        content = generateHeartbeatMd(manifest);
      } else if (!content && fileName === "AGENTS.md") {
        // AGENTS.md is left to the workspace bootstrap system
        result.filesSkipped.push(fileName);
        continue;
      }

      if (content && !dryRun) {
        await writeFile(join(workspaceDir, fileName), content, "utf-8");
        result.filesWritten.push(fileName);
      } else if (!content) {
        result.filesSkipped.push(fileName);
      } else {
        result.filesWritten.push(fileName);
      }
    }
  } else {
    result.filesSkipped.push(...TEMPLATE_ONLY_FILES);
  }

  // Never-touch files are always skipped
  result.filesSkipped.push(...NEVER_TOUCH_FILES);

  // Write version file
  if (!dryRun) {
    await writeDeployedVersion(workspaceDir, manifest.version);
  }

  return result;
}

/**
 * Deploy all agents from a blueprints directory to their workspace dirs.
 */
export async function deployAllAgents(
  blueprintsDir: string,
  resolveWorkspace: (agentId: string) => string,
  opts: DeployOptions = {},
  templateBaseDir?: string,
): Promise<DeployResult[]> {
  const entries = await readdir(blueprintsDir, { withFileTypes: true });
  const results: DeployResult[] = [];

  for (const entry of entries.filter((e) => e.isDirectory())) {
    const dir = join(blueprintsDir, entry.name);
    const blueprint = await loadBlueprint(dir);
    if (!blueprint) {
      continue;
    }

    // Skip bundles — they don't deploy to workspaces
    if (blueprint.manifest.is_bundle) {
      continue;
    }

    const workspaceDir = resolveWorkspace(blueprint.manifest.id);
    const result = await deployAgent(blueprint, workspaceDir, opts, templateBaseDir);
    results.push(result);
  }

  return results;
}

/**
 * Check deploy status for an agent.
 */
export async function checkDeployStatus(
  blueprint: AgentBlueprint,
  workspaceDir: string,
): Promise<{
  deployed: boolean;
  currentVersion: string | null;
  manifestVersion: string;
  needsUpgrade: boolean;
  workspaceExists: boolean;
}> {
  const workspaceExists = await fileExists(workspaceDir);
  const currentVersion = workspaceExists ? await readDeployedVersion(workspaceDir) : null;

  return {
    deployed: currentVersion !== null,
    currentVersion,
    manifestVersion: blueprint.manifest.version,
    needsUpgrade: currentVersion !== null && currentVersion !== blueprint.manifest.version,
    workspaceExists,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
