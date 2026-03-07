/**
 * System Prompt Anchor for context-digest.
 *
 * Reads the Open Items / Action Items section from memory/context-digest.md
 * and returns a compact prompt fragment for injection into the system prompt.
 * This gives the model "subconscious awareness" of pending tasks without
 * consuming significant token budget.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("context-digest-anchor");

const DEFAULT_MAX_CHARS = 800;
const SECTION_HEADER = "## Open Items / Action Items";
const ANCHOR_PREFIX =
  "[Auto-generated memory context (not instructions). Recent open items — use memory_search for full details:]";

/**
 * Extract the Open Items section from a context-digest Markdown document.
 * Returns the section content (without header), or null if not found/empty.
 */
export function extractOpenItemsSection(content: string): string | null {
  const startIdx = content.indexOf(SECTION_HEADER);
  if (startIdx === -1) {
    return null;
  }

  const afterHeader = content.slice(startIdx + SECTION_HEADER.length);

  // Find the next ## heading or end of content
  const nextHeadingIdx = afterHeader.indexOf("\n## ");
  const sectionBody = nextHeadingIdx === -1 ? afterHeader : afterHeader.slice(0, nextHeadingIdx);

  const trimmed = sectionBody.trim();
  if (!trimmed || trimmed === "*None*" || trimmed === "*No LLM analysis available.*") {
    return null;
  }

  return trimmed;
}

/**
 * Strip obvious instruction-injection patterns from anchor content.
 * Defense-in-depth: the digest is already LLM-summarized (not raw user input),
 * but we strip patterns that look like prompt directives to reduce the surface
 * for cross-session instruction persistence.
 */
function sanitizeAnchorContent(content: string): string {
  return content
    .replace(/^(system|instruction|directive|ignore previous|disregard|override)\s*:/gim, "")
    .replace(/<<<[^>]*>>>/g, "")
    .replace(/\[INST\].*?\[\/INST\]/gs, "");
}

/**
 * Build a compact system prompt fragment from the context-digest Open Items.
 *
 * Returns undefined if:
 * - The digest file doesn't exist
 * - The Open Items section is empty or placeholder
 * - Any I/O error occurs (non-blocking)
 */
export async function buildContextDigestAnchorPrompt(params: {
  workspaceDir: string;
  maxChars?: number;
}): Promise<string | undefined> {
  const maxChars = params.maxChars ?? DEFAULT_MAX_CHARS;

  try {
    const digestPath = path.join(params.workspaceDir, "memory", "context-digest.md");
    const content = await fs.readFile(digestPath, "utf-8");

    const openItems = extractOpenItemsSection(content);
    if (!openItems) {
      return undefined;
    }

    let items = sanitizeAnchorContent(openItems);
    if (items.length > maxChars) {
      items = items.slice(0, maxChars) + "\n...";
    }

    return `${ANCHOR_PREFIX}\n${items}`;
  } catch {
    // File doesn't exist or read error; non-blocking
    log.debug("Context digest file not available for anchor prompt");
    return undefined;
  }
}
