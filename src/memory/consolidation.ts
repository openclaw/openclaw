/**
 * Memory Consolidation (Phase 1.2)
 *
 * Automatically consolidates memory files:
 * - Daily notes → Weekly summary (every 7 days)
 * - Weekly summaries → Monthly summary (every 30 days)
 * - Monthly summaries → Long-term memory updates
 *
 * Uses LLM-based summarization with structured output.
 */

import { existsSync } from "fs";
import { readdir, readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";

export type ConsolidationLevel = "daily" | "weekly" | "monthly" | "longterm";

export interface ConsolidationParams {
  memoryDir: string;
  outputDir: string;
  llmProvider: "openai" | "anthropic" | "gemini";
  model?: string;
}

export interface MemoryFile {
  path: string;
  date: string;
  content: string;
}

export interface ConsolidatedMemory {
  level: ConsolidationLevel;
  period: string; // e.g., "2026-W06" for week 6, "2026-02" for February
  sourceFiles: string[];
  summary: string;
  keyFacts: string[];
  decisions: string[];
  preferences: string[];
  timestamp: number;
}

/**
 * Find all daily memory files in a directory.
 */
export async function findMemoryFiles(
  memoryDir: string,
  startDate?: string,
  endDate?: string,
): Promise<MemoryFile[]> {
  const files: MemoryFile[] = [];

  try {
    const entries = await readdir(memoryDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      // Match YYYY-MM-DD.md pattern
      const match = entry.name.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
      if (!match) {
        continue;
      }

      const date = match[1];

      // Filter by date range if specified
      if (startDate && date < startDate) {
        continue;
      }
      if (endDate && date > endDate) {
        continue;
      }

      const filePath = join(memoryDir, entry.name);
      const content = await readFile(filePath, "utf-8");

      files.push({ path: filePath, date, content });
    }
  } catch (err) {
    console.error(`Error reading memory directory: ${String(err)}`);
  }

  // Sort by date
  files.sort((a, b) => a.date.localeCompare(b.date));

  return files;
}

/**
 * Get the week number from a date string.
 */
export function getWeekNumber(dateStr: string): string {
  const date = new Date(dateStr);
  const year = date.getFullYear();
  const firstDayOfYear = new Date(year, 0, 1);
  const pastDaysOfYear = (date.getTime() - firstDayOfYear.getTime()) / 86400000;
  const weekNumber = Math.ceil((pastDaysOfYear + firstDayOfYear.getDay() + 1) / 7);
  return `${year}-W${weekNumber.toString().padStart(2, "0")}`;
}

/**
 * Get the month from a date string.
 */
export function getMonthString(dateStr: string): string {
  return dateStr.substring(0, 7); // YYYY-MM
}

/**
 * Group memory files by consolidation period.
 */
export function groupByPeriod(
  files: MemoryFile[],
  level: "weekly" | "monthly",
): Map<string, MemoryFile[]> {
  const groups = new Map<string, MemoryFile[]>();

  for (const file of files) {
    const period = level === "weekly" ? getWeekNumber(file.date) : getMonthString(file.date);

    if (!groups.has(period)) {
      groups.set(period, []);
    }
    groups.get(period)!.push(file);
  }

  return groups;
}

/**
 * Build a prompt for LLM-based summarization.
 */
export function buildConsolidationPrompt(
  files: MemoryFile[],
  level: ConsolidationLevel,
  period: string,
): string {
  const fileList = files.map((f) => `## ${f.date}\n\n${f.content}`).join("\n\n---\n\n");

  return `# Memory Consolidation Prompt

You are consolidating daily memory notes into a ${level} summary.

## Period: ${period}

## Source Files

${fileList}

## Task

Create a ${level} summary that extracts:

1. **Key Facts**: Important information, events, decisions, or context
2. **Decisions Made**: Any choices, plans, or commitments
3. **Preferences Expressed**: User preferences, opinions, or tastes mentioned
4. **Summary**: A brief overview of what happened

## Output Format (JSON)

Return a JSON object with these fields:
- "summary": 2-3 sentence overview
- "keyFacts": array of important facts (max 10)
- "decisions": array of decisions made (max 5)
- "preferences": array of preferences expressed (max 5)

Be concise and focus on what's actually important. Ignore trivial details.

JSON Output:`;
}

/**
 * Parse LLM response into ConsolidatedMemory structure.
 */
export function parseConsolidationResponse(
  response: string,
  level: ConsolidationLevel,
  period: string,
  sourceFiles: string[],
): ConsolidatedMemory {
  // Try to extract JSON from response
  const jsonMatch = response.match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    // Fallback: create basic structure
    return {
      level,
      period,
      sourceFiles: sourceFiles.map((f) => f),
      summary: response.substring(0, 500),
      keyFacts: [],
      decisions: [],
      preferences: [],
      timestamp: Date.now(),
    };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      level,
      period,
      sourceFiles: sourceFiles.map((f) => f),
      summary: parsed.summary || "",
      keyFacts: parsed.keyFacts || [],
      decisions: parsed.decisions || [],
      preferences: parsed.preferences || [],
      timestamp: Date.now(),
    };
  } catch {
    // If JSON parse fails, return raw response as summary
    return {
      level,
      period,
      sourceFiles: sourceFiles.map((f) => f),
      summary: response.substring(0, 500),
      keyFacts: [],
      decisions: [],
      preferences: [],
      timestamp: Date.now(),
    };
  }
}

/**
 * Convert consolidated memory to markdown for storage.
 */
export function consolidatedToMarkdown(consolidated: ConsolidatedMemory): string {
  const lines: string[] = [
    `# Consolidated Memory - ${consolidated.period}`,
    "",
    `**Level:** ${consolidated.level}`,
    `**Consolidated:** ${new Date(consolidated.timestamp).toISOString()}`,
    "",
    `**Source Files:** ${consolidated.sourceFiles.join(", ")}`,
    "",
    "## Summary",
    "",
    consolidated.summary,
    "",
  ];

  if (consolidated.keyFacts.length > 0) {
    lines.push("## Key Facts", "");
    for (const fact of consolidated.keyFacts) {
      lines.push(`- ${fact}`);
    }
    lines.push("");
  }

  if (consolidated.decisions.length > 0) {
    lines.push("## Decisions", "");
    for (const decision of consolidated.decisions) {
      lines.push(`- ${decision}`);
    }
    lines.push("");
  }

  if (consolidated.preferences.length > 0) {
    lines.push("## Preferences", "");
    for (const pref of consolidated.preferences) {
      lines.push(`- ${pref}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Run consolidation for a specific period.
 */
export async function runConsolidation(
  files: MemoryFile[],
  level: ConsolidationLevel,
  period: string,
  _outputDir: string,
): Promise<ConsolidatedMemory | null> {
  if (files.length === 0) {
    console.log(`No files to consolidate for ${period}`);
    return null;
  }

  console.log(`Consolidating ${files.length} files for ${period} (${level})...`);

  const prompt = buildConsolidationPrompt(files, level, period);

  // TODO: Call LLM API here
  // For now, return a placeholder
  console.log("LLM integration not yet implemented - would send prompt:");
  console.log(prompt.substring(0, 500) + "...");

  return {
    level,
    period,
    sourceFiles: files.map((f) => f.date),
    summary: "(Placeholder - LLM integration needed)",
    keyFacts: [],
    decisions: [],
    preferences: [],
    timestamp: Date.now(),
  };
}

/**
 * Main consolidation runner.
 */
export async function runFullConsolidation(params: ConsolidationParams): Promise<void> {
  const { memoryDir, outputDir } = params;

  // Ensure output directory exists
  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true });
  }

  // Find all daily memory files
  const allFiles = await findMemoryFiles(memoryDir);
  console.log(`Found ${allFiles.length} daily memory files`);

  if (allFiles.length === 0) {
    console.log("No memory files to consolidate");
    return;
  }

  // Group by week
  const weeklyGroups = groupByPeriod(allFiles, "weekly");
  console.log(`Found ${weeklyGroups.size} weeks to consolidate`);

  // Consolidate each week
  for (const [week, files] of weeklyGroups) {
    const consolidated = await runConsolidation(files, "weekly", week, outputDir);

    if (consolidated) {
      const outputPath = join(outputDir, `weekly-${week}.md`);
      const markdown = consolidatedToMarkdown(consolidated);
      await writeFile(outputPath, markdown, "utf-8");
      console.log(`Wrote: ${outputPath}`);
    }
  }

  // Group by month
  const monthlyGroups = groupByPeriod(allFiles, "monthly");
  console.log(`Found ${monthlyGroups.size} months to consolidate`);

  // Consolidate each month
  for (const [month, files] of monthlyGroups) {
    const consolidated = await runConsolidation(files, "monthly", month, outputDir);

    if (consolidated) {
      const outputPath = join(outputDir, `monthly-${month}.md`);
      const markdown = consolidatedToMarkdown(consolidated);
      await writeFile(outputPath, markdown, "utf-8");
      console.log(`Wrote: ${outputPath}`);
    }
  }

  console.log("Consolidation complete!");
}

// CLI runner
if (require.main === module) {
  const memoryDir = process.argv[2] || "./memory";
  const outputDir = process.argv[3] || "./memory/consolidated";

  runFullConsolidation({
    memoryDir,
    outputDir,
    llmProvider: "openai",
  }).catch(console.error);
}
