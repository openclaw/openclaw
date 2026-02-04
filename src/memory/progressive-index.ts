/**
 * Progressive Memory Index Generator.
 *
 * Generates a lean, always-in-context memory index (<1500 tokens) from the
 * progressive store. Critical entries get full text; lower priority entries
 * get one-line summaries with hints to use memory_recall for details.
 *
 * Output: markdown suitable for system prompt injection.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type {
  MemoryCategory,
  MemoryPriority,
  ProgressiveMemoryEntry,
} from "./progressive-types.js";
import { ProgressiveMemoryStore } from "./progressive-store.js";
import { PRIORITY_ORDER } from "./progressive-types.js";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Target maximum tokens for the always-loaded index. */
const INDEX_TOKEN_TARGET = 1500;

/** Chars per token estimate. */
const CHARS_PER_TOKEN = 4;

/** Category display order and labels. */
const CATEGORY_ORDER: Array<{ category: MemoryCategory; label: string; icon: string }> = [
  { category: "instruction", label: "Instructions", icon: "I" },
  { category: "person", label: "People", icon: "P" },
  { category: "preference", label: "Preferences", icon: "★" },
  { category: "project", label: "Projects", icon: "◆" },
  { category: "fact", label: "Facts", icon: "•" },
  { category: "decision", label: "Decisions", icon: "→" },
  { category: "insight", label: "Insights", icon: "◇" },
];

// ─── Index generation ────────────────────────────────────────────────────────

export interface MemoryIndexOptions {
  /** Max tokens for the index (default: 1500). */
  maxTokens?: number;
  /** Whether to include domain summary section. */
  includeDomains?: boolean;
}

/**
 * Generate a lean memory index markdown string from the progressive store.
 */
export function generateMemoryIndex(
  store: ProgressiveMemoryStore,
  options?: MemoryIndexOptions,
): string {
  const maxTokens = options?.maxTokens ?? INDEX_TOKEN_TARGET;
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const includeDomains = options?.includeDomains ?? true;

  const lines: string[] = [];
  let charCount = 0;

  const addLine = (line: string): boolean => {
    const cost = line.length + 1; // +1 for newline
    if (charCount + cost > maxChars && lines.length > 5) {
      return false; // Budget exceeded, stop adding
    }
    lines.push(line);
    charCount += cost;
    return true;
  };

  addLine("# Memory Index");
  addLine("");

  // ── Critical entries (full text) ───────────────────────────────────────
  const criticalEntries = store.list({ priorityMin: "critical" });
  const critical = criticalEntries.filter((e) => e.priority === "critical" && !e.archived);

  if (critical.length > 0) {
    addLine("## Critical (always relevant)");
    for (const entry of critical) {
      const prefix = categoryPrefix(entry.category);
      const content = compressContent(entry.content, 200);
      if (!addLine(`- [${prefix}] ${content}`)) break;
    }
    addLine("");
  }

  // ── High-priority entries (one-line summaries) ─────────────────────────
  const highEntries = store
    .list({ priorityMin: "high" })
    .filter((e) => e.priority === "high" && !e.archived);

  if (highEntries.length > 0) {
    // Group by category
    const grouped = groupByCategory(highEntries);

    for (const { category, label, icon } of CATEGORY_ORDER) {
      const entries = grouped.get(category);
      if (!entries || entries.length === 0) continue;

      if (!addLine(`## ${label}`)) break;
      for (const entry of entries) {
        const summary = compressContent(entry.content, 120);
        if (!addLine(`- ${summary}`)) break;
      }
      addLine("");
    }
  }

  // ── Domain summaries ───────────────────────────────────────────────────
  if (includeDomains) {
    const allEntries = store.list();
    const categories = new Map<MemoryCategory, number>();
    for (const entry of allEntries) {
      categories.set(entry.category, (categories.get(entry.category) ?? 0) + 1);
    }

    if (categories.size > 0) {
      addLine("## Domains (use memory_recall to load)");
      for (const { category, label } of CATEGORY_ORDER) {
        const count = categories.get(category);
        if (!count) continue;
        if (
          !addLine(
            `- [${category}] ${label}: ${count} entries → \`memory_recall(categories:["${category}"])\``,
          )
        )
          break;
      }
      addLine("");
    }
  }

  // ── Legend ──────────────────────────────────────────────────────────────
  addLine("[P]=person [I]=instruction [★]=preference [◆]=project — Full entries via memory_recall");

  const result = lines.join("\n");
  return result;
}

/**
 * Generate the index and write it to a file.
 */
export async function writeMemoryIndex(
  store: ProgressiveMemoryStore,
  outputPath: string,
  options?: MemoryIndexOptions,
): Promise<{ path: string; tokenEstimate: number }> {
  const content = generateMemoryIndex(store, options);
  const dir = path.dirname(outputPath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(outputPath, content, "utf-8");

  return {
    path: outputPath,
    tokenEstimate: Math.ceil(content.length / CHARS_PER_TOKEN),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function categoryPrefix(category: MemoryCategory): string {
  const found = CATEGORY_ORDER.find((c) => c.category === category);
  return found?.icon ?? "•";
}

function groupByCategory(
  entries: ProgressiveMemoryEntry[],
): Map<MemoryCategory, ProgressiveMemoryEntry[]> {
  const map = new Map<MemoryCategory, ProgressiveMemoryEntry[]>();
  for (const entry of entries) {
    let list = map.get(entry.category);
    if (!list) {
      list = [];
      map.set(entry.category, list);
    }
    list.push(entry);
  }
  return map;
}

/**
 * Compress content into a single-line summary.
 * Strips markdown formatting, collapses whitespace, truncates.
 */
function compressContent(content: string, maxChars: number): string {
  let compressed = content
    // Collapse newlines
    .replace(/\n+/g, " ")
    // Strip markdown bold/italic
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    // Strip markdown code blocks
    .replace(/```[\s\S]*?```/g, "[code]")
    .replace(/`(.+?)`/g, "$1")
    // Strip markdown links
    .replace(/\[(.+?)\]\(.+?\)/g, "$1")
    // Collapse whitespace
    .replace(/\s+/g, " ")
    .trim();

  if (compressed.length > maxChars) {
    compressed = compressed.slice(0, maxChars - 1) + "…";
  }

  return compressed;
}
