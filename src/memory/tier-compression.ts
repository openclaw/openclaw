/**
 * T1→T2 Compression Pipeline
 *
 * Compresses daily memory files older than `minAgeHours` into topic-grouped
 * short-term memory files. Uses an LLM to preserve durable facts while
 * removing conversational noise.
 */

import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import type { ResolvedTierConfig } from "./tier-types.js";
import { ensureDir } from "./internal.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/tier-compression");

const DEFAULT_COMPRESSION_PROMPT = [
  "You are a memory compression assistant. Given raw daily memory entries grouped by topic,",
  "produce a concise compressed version that preserves:",
  "- Key decisions and their rationale",
  "- Dates, deadlines, and timestamps",
  "- Names of people, projects, and tools",
  "- Action items and TODOs",
  "- Technical details that would be hard to re-derive",
  "",
  "Remove:",
  "- Conversational filler and greetings",
  "- Redundant restatements of the same fact",
  "- Session metadata (session IDs, source info)",
  "",
  "Output clean markdown with the same topic heading. Stay under the token budget.",
].join("\n");

export type CompressDailyParams = {
  workspaceDir: string;
  db: DatabaseSync;
  tierConfig: ResolvedTierConfig;
  cfg: OpenClawConfig;
  callLlm: (params: { prompt: string; system: string; model?: string }) => Promise<string>;
};

type TopicGroup = {
  topic: string;
  slug: string;
  content: string[];
  sourceFiles: string[];
};

/**
 * Compress daily memory files into short-term topic files.
 *
 * 1. List files in memory/daily/ older than minAgeHours
 * 2. Parse ## Topic headings, build topic→content map
 * 3. For each topic: call LLM with compression prompt
 * 4. Write to memory/short-term/<topic-slug>.md
 * 5. Update memory_tiers and _index.json
 */
export async function compressDailyToShortTerm(params: CompressDailyParams): Promise<number> {
  const { workspaceDir, db, tierConfig } = params;
  const dailyDir = path.join(workspaceDir, "memory", "daily");
  const shortTermDir = path.join(workspaceDir, "memory", "short-term");

  let entries: string[];
  try {
    entries = await fs.readdir(dailyDir);
  } catch {
    return 0; // No daily directory yet
  }

  const cutoff = Date.now() - tierConfig.compression.minAgeHours * 60 * 60 * 1000;
  const eligibleFiles: string[] = [];

  for (const entry of entries) {
    if (!entry.endsWith(".md")) {
      continue;
    }
    const absPath = path.join(dailyDir, entry);
    try {
      const stat = await fs.stat(absPath);
      if (stat.mtimeMs < cutoff) {
        eligibleFiles.push(absPath);
      }
    } catch {
      continue;
    }
  }

  if (eligibleFiles.length === 0) {
    return 0;
  }

  // Parse topic headings from eligible files
  const topicGroups = await buildTopicGroups(eligibleFiles);
  if (topicGroups.length === 0) {
    return 0;
  }

  ensureDir(shortTermDir);
  let compressed = 0;

  for (const group of topicGroups) {
    try {
      const combinedContent = group.content.join("\n\n---\n\n");
      const system = tierConfig.compression.prompt ?? DEFAULT_COMPRESSION_PROMPT;
      const prompt = `## ${group.topic}\n\n${combinedContent}\n\nCompress to under ${tierConfig.compression.maxCompressedTokens} tokens.`;

      const result = await params.callLlm({
        prompt,
        system,
        model: tierConfig.compression.model,
      });

      const targetPath = path.join(shortTermDir, `${group.slug}.md`);
      const relPath = path.relative(workspaceDir, targetPath).replace(/\\/g, "/");

      // Merge with existing content if file exists
      let finalContent = result;
      try {
        const existing = await fs.readFile(targetPath, "utf-8");
        if (existing.trim()) {
          finalContent = `${existing.trimEnd()}\n\n---\n\n${result}`;
        }
      } catch {
        // File doesn't exist yet
      }

      await fs.writeFile(targetPath, finalContent, "utf-8");

      // Update memory_tiers table
      const now = Date.now();
      db.prepare(
        `INSERT INTO memory_tiers (path, tier, compressed_from, compression_model, compression_at)
         VALUES (?, 'T2', ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           tier = 'T2',
           compressed_from = excluded.compressed_from,
           compression_model = excluded.compression_model,
           compression_at = excluded.compression_at`,
      ).run(relPath, group.sourceFiles.join(","), tierConfig.compression.model ?? "default", now);

      compressed += 1;
      log.debug(`compressed topic "${group.topic}" → ${relPath}`);
    } catch (err) {
      log.warn(
        `failed to compress topic "${group.topic}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Update _index.json manifest
  await updateShortTermIndex(shortTermDir);

  // Mark daily files as compressed (update their tier record, but don't delete yet)
  for (const absPath of eligibleFiles) {
    const relPath = path.relative(workspaceDir, absPath).replace(/\\/g, "/");
    db.prepare(
      `INSERT INTO memory_tiers (path, tier, compression_at)
       VALUES (?, 'T1', ?)
       ON CONFLICT(path) DO UPDATE SET
         compression_at = excluded.compression_at`,
    ).run(relPath, Date.now());
  }

  return compressed;
}

/**
 * Clean up daily files that have been compressed and are older than 7 days.
 */
export async function cleanupCompressedDailyFiles(params: {
  workspaceDir: string;
  db: DatabaseSync;
  maxAgeDays?: number;
}): Promise<number> {
  const { workspaceDir, db, maxAgeDays = 7 } = params;
  const dailyDir = path.join(workspaceDir, "memory", "daily");
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  let entries: string[];
  try {
    entries = await fs.readdir(dailyDir);
  } catch {
    return 0;
  }

  let cleaned = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".md")) {
      continue;
    }
    const absPath = path.join(dailyDir, entry);
    const relPath = path.relative(workspaceDir, absPath).replace(/\\/g, "/");

    // Check if this file has been compressed
    const row = db
      .prepare(`SELECT compression_at FROM memory_tiers WHERE path = ? AND compression_at IS NOT NULL`)
      .get(relPath) as { compression_at: number } | undefined;

    if (!row) {
      continue;
    }

    try {
      const stat = await fs.stat(absPath);
      if (stat.mtimeMs < cutoff) {
        await fs.unlink(absPath);
        db.prepare(`DELETE FROM memory_tiers WHERE path = ?`).run(relPath);
        db.prepare(`DELETE FROM files WHERE path = ?`).run(relPath);
        db.prepare(`DELETE FROM chunks WHERE path = ?`).run(relPath);
        cleaned += 1;
        log.debug(`cleaned up compressed daily file: ${relPath}`);
      }
    } catch {
      continue;
    }
  }

  return cleaned;
}

async function buildTopicGroups(files: string[]): Promise<TopicGroup[]> {
  const topicMap = new Map<string, TopicGroup>();

  for (const absPath of files) {
    let content: string;
    try {
      content = await fs.readFile(absPath, "utf-8");
    } catch {
      continue;
    }

    const lines = content.split("\n");
    let currentTopic = "General";
    let currentContent: string[] = [];

    const flushTopic = () => {
      if (currentContent.length === 0) {
        return;
      }
      const text = currentContent.join("\n").trim();
      if (!text) {
        return;
      }
      const existing = topicMap.get(currentTopic);
      if (existing) {
        existing.content.push(text);
        if (!existing.sourceFiles.includes(absPath)) {
          existing.sourceFiles.push(absPath);
        }
      } else {
        topicMap.set(currentTopic, {
          topic: currentTopic,
          slug: slugify(currentTopic),
          content: [text],
          sourceFiles: [absPath],
        });
      }
    };

    for (const line of lines) {
      const headingMatch = line.match(/^##\s+(.+)$/);
      if (headingMatch) {
        flushTopic();
        currentTopic = headingMatch[1].trim();
        currentContent = [];
      } else {
        currentContent.push(line);
      }
    }
    flushTopic();
  }

  return Array.from(topicMap.values());
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "general";
}

async function updateShortTermIndex(dir: string): Promise<void> {
  try {
    const entries = await fs.readdir(dir);
    const mdFiles = entries.filter((e) => e.endsWith(".md"));
    const index: Record<string, { file: string; updatedAt: number }> = {};

    for (const file of mdFiles) {
      const absPath = path.join(dir, file);
      try {
        const stat = await fs.stat(absPath);
        const topic = file.replace(/\.md$/, "");
        index[topic] = { file, updatedAt: stat.mtimeMs };
      } catch {
        continue;
      }
    }

    await fs.writeFile(path.join(dir, "_index.json"), JSON.stringify(index, null, 2), "utf-8");
  } catch (err) {
    log.warn(`failed to update short-term index: ${err instanceof Error ? err.message : String(err)}`);
  }
}
