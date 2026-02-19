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

export type FabricSkillTarget = {
  id: string;
  name: string;
  description?: string;
  systemPrompt?: string;
  tools?: Array<{ name: string; description?: string }>;
  kind: "agent" | "agent-system";
  memberCount?: number;
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
// SKILL.md content builder
// ---------------------------------------------------------------------------

function buildSkillContent(target: FabricSkillTarget): string {
  const slug = slugify(target.name);
  const kindLabel = target.kind === "agent" ? "Agent" : "Agent System";
  const description =
    target.description || target.systemPrompt
      ? truncate(target.description || target.systemPrompt || "", 100)
      : `Cloud.ru AI Fabric ${kindLabel}`;

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

  // Description
  if (target.description) {
    lines.push(target.description);
    lines.push("");
  }

  // Agent capabilities from system prompt
  lines.push("## Agent capabilities");
  lines.push("");
  if (target.systemPrompt) {
    lines.push(truncate(target.systemPrompt, 500));
  } else {
    lines.push("No system prompt available.");
  }
  lines.push("");

  // Tools (for agents)
  if (target.tools && target.tools.length > 0) {
    lines.push("## Available tools");
    lines.push("");
    for (const tool of target.tools) {
      const desc = tool.description ? `: ${tool.description}` : "";
      lines.push(`- ${tool.name}${desc}`);
    }
    lines.push("");
  }

  // Member count (for agent systems)
  if (target.kind === "agent-system" && target.memberCount !== undefined) {
    lines.push(`This agent system coordinates ${target.memberCount} member agents.`);
    lines.push("");
  }

  // Usage
  lines.push("## How to use");
  lines.push("");
  lines.push(`Run this command to interact with this ${kindLabel.toLowerCase()}:`);
  lines.push("");
  lines.push("```bash");
  lines.push(`openclaw fabric ask "${target.name}" "$PROMPT"`);
  lines.push("```");
  lines.push("");
  lines.push(
    "Replace `$PROMPT` with the user's question. The command handles authentication and A2A protocol.",
  );

  return lines.join("\n");
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
