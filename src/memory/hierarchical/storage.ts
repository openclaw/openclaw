/**
 * Storage layer for hierarchical memory summaries.
 *
 * Directory structure:
 *   ~/.clawdbot/agents/<agentId>/memory/summaries/
 *   ├── index.json
 *   ├── L1/
 *   │   ├── 0001.md
 *   │   └── ...
 *   ├── L2/
 *   │   └── ...
 *   └── L3/
 *       └── ...
 */

import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../../routing/session-key.js";
import {
  createEmptyIndex,
  type SummaryEntry,
  type SummaryIndex,
  type SummaryLevel,
} from "./types.js";

const INDEX_FILENAME = "index.json";
const SUMMARIES_DIR = "summaries";

/** Resolve the summaries directory for an agent */
export function resolveSummariesDir(agentId?: string): string {
  const root = resolveStateDir();
  const id = normalizeAgentId(agentId ?? DEFAULT_AGENT_ID);
  return path.join(root, "agents", id, "memory", SUMMARIES_DIR);
}

/** Resolve the index.json path for an agent */
export function resolveIndexPath(agentId?: string): string {
  return path.join(resolveSummariesDir(agentId), INDEX_FILENAME);
}

/** Resolve the directory for a specific level */
export function resolveLevelDir(level: SummaryLevel, agentId?: string): string {
  return path.join(resolveSummariesDir(agentId), level);
}

/** Resolve the path to a specific summary file */
export function resolveSummaryPath(level: SummaryLevel, id: string, agentId?: string): string {
  return path.join(resolveLevelDir(level, agentId), `${id}.md`);
}

/** Ensure the summaries directory structure exists */
export async function ensureSummariesDir(agentId?: string): Promise<void> {
  const baseDir = resolveSummariesDir(agentId);
  await fs.mkdir(path.join(baseDir, "L1"), { recursive: true });
  await fs.mkdir(path.join(baseDir, "L2"), { recursive: true });
  await fs.mkdir(path.join(baseDir, "L3"), { recursive: true });
}

/** Load the summary index, creating an empty one if it doesn't exist */
export async function loadSummaryIndex(agentId?: string): Promise<SummaryIndex> {
  const indexPath = resolveIndexPath(agentId);

  try {
    const content = await fs.readFile(indexPath, "utf-8");
    const parsed = JSON.parse(content) as SummaryIndex;

    // Validate version (cast to unknown for future-proofing)
    const version = parsed.version as unknown;
    if (version !== 1) {
      console.warn(`Unknown summary index version ${String(version)}, using as-is`);
    }

    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Return empty index, will be created on first save
      const resolvedAgentId = normalizeAgentId(agentId ?? DEFAULT_AGENT_ID);
      return createEmptyIndex(resolvedAgentId);
    }
    throw err;
  }
}

/** Save the summary index atomically */
export async function saveSummaryIndex(index: SummaryIndex, agentId?: string): Promise<void> {
  await ensureSummariesDir(agentId);

  const indexPath = resolveIndexPath(agentId);
  const tempPath = `${indexPath}.tmp.${process.pid}.${Date.now()}`;

  const content = JSON.stringify(index, null, 2);
  await fs.writeFile(tempPath, content, "utf-8");
  await fs.rename(tempPath, indexPath);
}

/** Generate the next summary ID for a level (e.g., "0001", "0002") */
export function generateNextSummaryId(index: SummaryIndex, level: SummaryLevel): string {
  const existing = index.levels[level];
  const maxId = existing.reduce((max, entry) => {
    const num = parseInt(entry.id, 10);
    return num > max ? num : max;
  }, 0);

  return String(maxId + 1).padStart(4, "0");
}

/** Format summary metadata as markdown frontmatter */
function formatSummaryMetadata(entry: SummaryEntry): string {
  const lines = [
    "<!--",
    `  id: ${entry.id}`,
    `  level: ${entry.level}`,
    `  createdAt: ${entry.createdAt}`,
    `  tokenEstimate: ${entry.tokenEstimate}`,
    `  sourceLevel: ${entry.sourceLevel}`,
    `  sourceIds: ${JSON.stringify(entry.sourceIds)}`,
  ];

  if (entry.sourceSessionId) {
    lines.push(`  sourceSessionId: ${entry.sourceSessionId}`);
  }

  lines.push("-->");
  return lines.join("\n");
}

/** Parse summary metadata from markdown frontmatter */
function parseSummaryMetadata(content: string): Partial<SummaryEntry> | null {
  const match = content.match(/^<!--\n([\s\S]*?)-->/);
  if (!match) {
    return null;
  }

  const metadata: Record<string, unknown> = {};
  const lines = match[1].split("\n");

  for (const line of lines) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) {
      continue;
    }

    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();

    if (key === "sourceIds") {
      try {
        metadata[key] = JSON.parse(value);
      } catch {
        metadata[key] = [];
      }
    } else if (key === "createdAt" || key === "tokenEstimate") {
      metadata[key] = parseInt(value, 10);
    } else {
      metadata[key] = value;
    }
  }

  return metadata as Partial<SummaryEntry>;
}

/** Extract just the summary content (without metadata) */
export function extractSummaryContent(fullContent: string): string {
  return fullContent.replace(/^<!--[\s\S]*?-->\n*/, "").trim();
}

/** Write a summary file with metadata */
export async function writeSummary(
  entry: SummaryEntry,
  content: string,
  agentId?: string,
): Promise<void> {
  await ensureSummariesDir(agentId);

  const summaryPath = resolveSummaryPath(entry.level, entry.id, agentId);
  const fullContent = `${formatSummaryMetadata(entry)}\n\n${content}`;

  const tempPath = `${summaryPath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tempPath, fullContent, "utf-8");
  await fs.rename(tempPath, summaryPath);
}

/** Read a summary file, returning both metadata and content */
export async function readSummary(
  level: SummaryLevel,
  id: string,
  agentId?: string,
): Promise<{ metadata: Partial<SummaryEntry>; content: string } | null> {
  const summaryPath = resolveSummaryPath(level, id, agentId);

  try {
    const fullContent = await fs.readFile(summaryPath, "utf-8");
    const metadata = parseSummaryMetadata(fullContent);
    const content = extractSummaryContent(fullContent);

    return { metadata: metadata ?? {}, content };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/** Load all summary contents for a level (for context injection) */
export async function loadSummaryContents(
  entries: SummaryEntry[],
  agentId?: string,
): Promise<string[]> {
  const contents: string[] = [];

  for (const entry of entries) {
    const result = await readSummary(entry.level, entry.id, agentId);
    if (result) {
      contents.push(result.content);
    }
  }

  return contents;
}

/** Check if summaries directory exists and has any data */
export async function hasSummaries(agentId?: string): Promise<boolean> {
  try {
    const index = await loadSummaryIndex(agentId);
    return index.levels.L1.length > 0 || index.levels.L2.length > 0 || index.levels.L3.length > 0;
  } catch {
    return false;
  }
}
