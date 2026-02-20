/**
 * AI Fabric Skill Generator
 *
 * Generates SKILL.md files for each Cloud.ru AI Fabric agent and agent
 * system, so that Claude CLI can discover and invoke them as slash commands.
 *
 * Each generated skill instructs Claude to run `openclaw fabric ask "<name>" "$PROMPT"`.
 *
 * Reusable across: sync orchestrator, CLI commands, gateway hooks.
 */

import { promises as fsp } from "node:fs";
import path from "node:path";
import { SYNC_MARKER } from "../agents/skills/claude-commands-sync.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FabricMcpToolInfo = {
  serverName: string;
  tools: Array<{ name: string; description?: string }>;
};

export type FabricSkillTarget = {
  id: string;
  name: string;
  description?: string;
  systemPrompt?: string;
  tools?: Array<{ name: string; description?: string }>;
  kind: "agent" | "agent-system";
  memberCount?: number;
  /** MCP servers available alongside this agent/system. */
  mcpServers?: FabricMcpToolInfo[];
};

export type GenerateFabricSkillsResult = {
  generated: number;
  cleaned: number;
};

// ---------------------------------------------------------------------------
// Slug helpers
// ---------------------------------------------------------------------------

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) {
    return text;
  }
  return text.slice(0, maxLen).trimEnd() + "...";
}

// ---------------------------------------------------------------------------
// Description builder
// ---------------------------------------------------------------------------

/** Turn `get_today_weather` into `get today weather`. */
function humanizeToolName(name: string): string {
  return name.replace(/[_-]+/g, " ").toLowerCase();
}

/** First sentence of a text block (up to first period+space or newline). */
function firstSentence(text: string): string {
  const match = text.match(/^(.+?(?:\.\s|\.\n|$))/s);
  return match ? match[1].replace(/\.\s*$/, "").trim() : text.trim();
}

/** Collect ALL tool names from direct tools + MCP server tools. */
function collectAllToolNames(target: FabricSkillTarget): string[] {
  const names: string[] = [];
  if (target.tools) {
    for (const t of target.tools) {
      names.push(t.name);
    }
  }
  if (target.mcpServers) {
    for (const mcp of target.mcpServers) {
      for (const t of mcp.tools) {
        names.push(t.name);
      }
    }
  }
  return names;
}

/**
 * Build a rich, informative description for the skill frontmatter.
 *
 * Goal: give the model enough signal to match user intent to the right skill.
 * Format: `"<base>. Capabilities: <tool1>, <tool2>, ..."`
 * Truncated to 200 chars max.
 */
function buildDescription(target: FabricSkillTarget): string {
  // Base: prefer explicit description, then first sentence of system prompt, then name
  let base: string;
  if (target.description) {
    base = firstSentence(target.description);
  } else if (target.systemPrompt) {
    base = firstSentence(target.systemPrompt);
  } else {
    base = `${target.name} agent`;
  }

  const toolNames = collectAllToolNames(target);
  if (toolNames.length === 0) {
    return truncate(base, 200);
  }

  const humanized = toolNames.map(humanizeToolName).join(", ");
  return truncate(`${base}. Capabilities: ${humanized}`, 200);
}

// ---------------------------------------------------------------------------
// SKILL.md content builder
// ---------------------------------------------------------------------------

function buildSkillContent(target: FabricSkillTarget): string {
  const slug = slugify(target.name);
  const kindLabel = target.kind === "agent" ? "Agent" : "Agent System";
  const description = buildDescription(target);

  const lines: string[] = [];

  // Frontmatter (must be first line for parsers) + sync marker
  lines.push("---");
  lines.push(`name: fabric-${slug}`);
  lines.push(`description: ${description}`);
  lines.push(`metadata: { "openclaw": { "emoji": "\uD83E\uDD16" } }`);
  lines.push("---");
  lines.push(SYNC_MARKER);
  lines.push("");

  // Header
  lines.push(`# ${target.name} (Cloud.ru AI Fabric ${kindLabel})`);
  lines.push("");

  // ── 1. INVOCATION (FIRST — model reads top-to-bottom) ──────────────
  lines.push("## IMPORTANT: How to invoke");
  lines.push("");
  lines.push(
    "You MUST use the Bash tool to execute the command below. Do NOT answer from general knowledge — always delegate to this agent.",
  );
  lines.push("");
  lines.push("```bash");
  lines.push(`openclaw fabric ask "${target.name}" "$PROMPT"`);
  lines.push("```");
  lines.push("");
  lines.push(
    "Replace `$PROMPT` with the user's question or request. The command handles authentication and the A2A protocol automatically.",
  );
  lines.push("");

  // ── 2. About this agent ────────────────────────────────────────────
  if (target.description) {
    lines.push("## About this agent");
    lines.push("");
    lines.push(target.description);
    lines.push("");
  }

  // ── 3. Agent capabilities — merged tools + MCP tools ───────────────
  const allTools = collectAllTools(target);
  if (allTools.length > 0) {
    lines.push("## Agent capabilities");
    lines.push("");
    lines.push(
      "The following capabilities are accessed via `openclaw fabric ask`, not via direct tool calls:",
    );
    lines.push("");
    for (const tool of allTools) {
      const desc = tool.description ? `: ${tool.description}` : "";
      lines.push(`- ${tool.name}${desc}`);
    }
    lines.push("");
  }

  // ── 4. System prompt context ───────────────────────────────────────
  if (target.systemPrompt) {
    lines.push("## System prompt context");
    lines.push("");
    lines.push(truncate(target.systemPrompt, 500));
    lines.push("");
  }

  // ── 5. Member count (for agent systems) ────────────────────────────
  if (target.kind === "agent-system" && target.memberCount !== undefined) {
    lines.push(`This agent system coordinates ${target.memberCount} member agents.`);
    lines.push("");
  }

  return lines.join("\n");
}

/** Merge direct tools + MCP server tools into a single flat list. */
function collectAllTools(target: FabricSkillTarget): Array<{ name: string; description?: string }> {
  const result: Array<{ name: string; description?: string }> = [];
  if (target.tools) {
    for (const t of target.tools) {
      result.push(t);
    }
  }
  if (target.mcpServers) {
    for (const mcp of target.mcpServers) {
      for (const t of mcp.tools) {
        result.push(t);
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Generate SKILL.md files for AI Fabric agents and agent systems.
 * Cleans stale synced skills that no longer match live resources.
 */
export async function generateFabricSkills(params: {
  targets: FabricSkillTarget[];
  skillsDir: string;
}): Promise<GenerateFabricSkillsResult> {
  const { targets, skillsDir } = params;

  await fsp.mkdir(skillsDir, { recursive: true });

  // Build expected directory names
  const expectedDirs = new Set<string>();
  for (const target of targets) {
    expectedDirs.add(`fabric-${slugify(target.name)}`);
  }

  // Clean stale skill directories
  let cleaned = 0;
  try {
    const existing = await fsp.readdir(skillsDir);
    for (const entry of existing) {
      if (!entry.startsWith("fabric-")) {
        continue;
      }
      if (expectedDirs.has(entry)) {
        continue;
      }

      const skillMdPath = path.join(skillsDir, entry, "SKILL.md");
      try {
        const content = await fsp.readFile(skillMdPath, "utf-8");
        if (content.includes(SYNC_MARKER)) {
          await fsp.rm(path.join(skillsDir, entry), { recursive: true });
          cleaned++;
        }
      } catch {
        // Not a synced skill or unreadable — skip
      }
    }
  } catch {
    // Directory doesn't exist yet — nothing to clean
  }

  // Generate skills
  let generated = 0;
  for (const target of targets) {
    const dirName = `fabric-${slugify(target.name)}`;
    const dirPath = path.join(skillsDir, dirName);
    const filePath = path.join(dirPath, "SKILL.md");

    await fsp.mkdir(dirPath, { recursive: true });
    const content = buildSkillContent(target);
    await fsp.writeFile(filePath, content, "utf-8");
    generated++;
  }

  return { generated, cleaned };
}
