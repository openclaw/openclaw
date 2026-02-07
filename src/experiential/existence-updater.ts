/**
 * EXISTENCE.md file updater.
 *
 * Manages reading and updating named sections in the EXISTENCE.md file,
 * used to persist experiential state between sessions.
 */

import fs from "node:fs/promises";
import { ExperientialStore } from "./store.js";

/**
 * Update a named section in an EXISTENCE.md file.
 * If the section exists, replaces its content. If not, appends it.
 */
export async function updateExistenceSection(params: {
  filePath: string;
  sectionName: string;
  content: string;
}): Promise<void> {
  const { filePath, sectionName, content } = params;

  let existing = "";
  try {
    existing = await fs.readFile(filePath, "utf-8");
  } catch {
    // File doesn't exist yet
  }

  const sectionHeader = `## ${sectionName}`;
  const sectionStart = existing.indexOf(sectionHeader);

  if (sectionStart === -1) {
    // Append new section
    const separator = existing.trim() ? "\n\n" : "";
    const updated = existing + separator + sectionHeader + "\n\n" + content + "\n";
    await fs.writeFile(filePath, updated, "utf-8");
    return;
  }

  // Find where this section ends (next ## heading or end of file)
  const afterHeader = sectionStart + sectionHeader.length;
  const nextSection = existing.indexOf("\n## ", afterHeader);
  const sectionEnd = nextSection === -1 ? existing.length : nextSection;

  const before = existing.slice(0, sectionStart);
  const after = existing.slice(sectionEnd);
  const updated = before + sectionHeader + "\n\n" + content + "\n" + after;
  await fs.writeFile(filePath, updated, "utf-8");
}

/**
 * Generate a current-state markdown snapshot from the experiential store.
 * Provides a summary of recent activity suitable for EXISTENCE.md.
 */
export async function generateExistenceSnapshot(store: ExperientialStore): Promise<string> {
  const summaries = store.getRecentSummaries(3);
  const checkpoint = store.getLatestCheckpoint();
  const moments = store.getRecentMoments(5, 0.6);

  const lines: string[] = [];

  if (summaries.length > 0) {
    lines.push("### Recent Session Topics");
    for (const s of summaries) {
      if (s.topics.length > 0) {
        lines.push(`- ${s.topics.join(", ")}`);
      }
    }
    lines.push("");
  }

  if (checkpoint) {
    lines.push("### Last Context Checkpoint");
    if (checkpoint.activeTopics.length > 0) {
      lines.push(`- Topics: ${checkpoint.activeTopics.join(", ")}`);
    }
    if (checkpoint.conversationAnchors.length > 0) {
      lines.push(`- Anchors: ${checkpoint.conversationAnchors.join("; ")}`);
    }
    lines.push("");
  }

  if (moments.length > 0) {
    lines.push("### Significant Moments");
    for (const m of moments) {
      lines.push(`- ${m.content.slice(0, 150)}`);
    }
    lines.push("");
  }

  if (lines.length === 0) {
    lines.push("*No experiential data recorded yet.*");
  }

  return lines.join("\n");
}
