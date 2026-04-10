import { parseDurationMs } from "../cli/parse-duration.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { escapeRegExp } from "../utils.js";
import { HEARTBEAT_TOKEN } from "./tokens.js";

export type HeartbeatTask = {
  name: string;
  interval: string;
  prompt: string;
};

// Default heartbeat prompt (used when config.agents.defaults.heartbeat.prompt is unset).
// Keep it tight and avoid encouraging the model to invent/rehash "open loops" from prior chat context.
export const HEARTBEAT_PROMPT =
  "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.";
export const DEFAULT_HEARTBEAT_EVERY = "30m";
export const DEFAULT_HEARTBEAT_ACK_MAX_CHARS = 300;

/**
 * Check if HEARTBEAT.md content is "effectively empty" - meaning it has no actionable tasks.
 * This allows skipping heartbeat API calls when no tasks are configured.
 *
 * A file is considered effectively empty if, after dropping HTML comment blocks
 * and any leading YAML frontmatter, every remaining line is one of:
 * - Whitespace / empty
 * - A markdown ATX header (`#`, `##`, ...) — including a leading `# ...` title
 * - An empty list item stub (`- `, `- [ ]`, `* `, `+ `)
 * - A bare `tasks:` declaration line (combined with the runner's
 *   `parseHeartbeatTasks(content).length === 0` gate, this still requires
 *   that no tasks were actually parsed before skipping)
 *
 * Note: A missing file returns false (not effectively empty) so the LLM can still
 * decide what to do. This function is only for when the file exists but has no content.
 */
export function isHeartbeatContentEffectivelyEmpty(content: string | undefined | null): boolean {
  if (content === undefined || content === null) {
    return false;
  }
  if (typeof content !== "string") {
    return false;
  }

  // Strip HTML comment blocks (including multi-line) so files that document
  // themselves with `<!-- ... -->` instead of markdown headers still count
  // as empty. Without this, a workspace template like
  //   <!-- Add tasks below when you want periodic checks. -->
  // would defeat the skip path and trigger a full heartbeat API call.
  let stripped = content.replace(/<!--[\s\S]*?-->/g, "");

  // Strip a leading YAML frontmatter block. Keep this narrow: a top-of-file
  // `--- ... ---` block can also be ordinary markdown content, and treating
  // that as frontmatter would incorrectly skip real heartbeat instructions.
  stripped = stripLeadingYamlFrontmatter(stripped);

  const lines = stripped.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    // Skip empty lines
    if (!trimmed) {
      continue;
    }
    // Skip markdown header lines (# followed by space or EOL, ## etc)
    // This intentionally does NOT skip lines like "#TODO" or "#hashtag" which might be content
    // (Those aren't valid markdown headers - ATX headers require space after #)
    if (/^#+(\s|$)/.test(trimmed)) {
      continue;
    }
    // Skip empty markdown list items like "- [ ]" or "* [ ]" or just "- "
    if (/^[-*+]\s*(\[[\sXx]?\]\s*)?$/.test(trimmed)) {
      continue;
    }
    // Skip a bare `tasks:` line. The runner additionally requires
    // `parseHeartbeatTasks(content).length === 0` before skipping, so a
    // declared-but-empty tasks block still routes to the skip path while
    // any line that actually parses as a task keeps the LLM call.
    if (/^tasks:\s*$/i.test(trimmed)) {
      continue;
    }
    // Found a non-empty, non-comment line - there's actionable content
    return false;
  }
  // All lines were either empty or comments
  return true;
}

function stripLeadingYamlFrontmatter(content: string): string {
  const lines = content.split(/\r?\n/);
  let start = 0;
  while (start < lines.length && !lines[start]?.trim()) {
    start += 1;
  }

  if (lines[start]?.trim() !== "---") {
    return content;
  }

  let end = start + 1;
  while (end < lines.length && lines[end]?.trim() !== "---") {
    end += 1;
  }
  if (end >= lines.length) {
    return content;
  }

  const bodyLines = lines.slice(start + 1, end);
  let sawYamlField = false;
  for (const line of bodyLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    if (/^[A-Za-z0-9_-]+:\s*(?:.*)?$/.test(trimmed)) {
      sawYamlField = true;
      continue;
    }
    if (sawYamlField && (/^\s+.+$/.test(line) || /^-\s+.+$/.test(trimmed))) {
      continue;
    }
    return content;
  }

  if (!sawYamlField && bodyLines.some((line) => line.trim())) {
    return content;
  }

  return [...lines.slice(0, start), ...lines.slice(end + 1)].join("\n");
}

export function resolveHeartbeatPrompt(raw?: string): string {
  const trimmed = normalizeOptionalString(raw) ?? "";
  return trimmed || HEARTBEAT_PROMPT;
}

export type StripHeartbeatMode = "heartbeat" | "message";

function stripTokenAtEdges(raw: string): { text: string; didStrip: boolean } {
  let text = raw.trim();
  if (!text) {
    return { text: "", didStrip: false };
  }

  const token = HEARTBEAT_TOKEN;
  const tokenAtEndWithOptionalTrailingPunctuation = new RegExp(
    `${escapeRegExp(token)}[^\\w]{0,4}$`,
  );
  if (!text.includes(token)) {
    return { text, didStrip: false };
  }

  let didStrip = false;
  let changed = true;
  while (changed) {
    changed = false;
    const next = text.trim();
    if (next.startsWith(token)) {
      const after = next.slice(token.length).trimStart();
      text = after;
      didStrip = true;
      changed = true;
      continue;
    }
    // Strip the token when it appears at the end of the text.
    // Also strip up to 4 trailing non-word characters the model may have appended
    // (e.g. ".", "!!!", "---"). Keep trailing punctuation only when real
    // sentence text exists before the token.
    if (tokenAtEndWithOptionalTrailingPunctuation.test(next)) {
      const idx = next.lastIndexOf(token);
      const before = next.slice(0, idx).trimEnd();
      if (!before) {
        text = "";
      } else {
        const after = next.slice(idx + token.length).trimStart();
        text = `${before}${after}`.trimEnd();
      }
      didStrip = true;
      changed = true;
    }
  }

  const collapsed = text.replace(/\s+/g, " ").trim();
  return { text: collapsed, didStrip };
}

export function stripHeartbeatToken(
  raw?: string,
  opts: { mode?: StripHeartbeatMode; maxAckChars?: number } = {},
) {
  if (!raw) {
    return { shouldSkip: true, text: "", didStrip: false };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { shouldSkip: true, text: "", didStrip: false };
  }

  const mode: StripHeartbeatMode = opts.mode ?? "message";
  const maxAckCharsRaw = opts.maxAckChars;
  const parsedAckChars =
    typeof maxAckCharsRaw === "string" ? Number(maxAckCharsRaw) : maxAckCharsRaw;
  const maxAckChars = Math.max(
    0,
    typeof parsedAckChars === "number" && Number.isFinite(parsedAckChars)
      ? parsedAckChars
      : DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  );

  // Normalize lightweight markup so HEARTBEAT_OK wrapped in HTML/Markdown
  // (e.g., <b>HEARTBEAT_OK</b> or **HEARTBEAT_OK**) still strips.
  const stripMarkup = (text: string) =>
    text
      // Drop HTML tags.
      .replace(/<[^>]*>/g, " ")
      // Decode common nbsp variant.
      .replace(/&nbsp;/gi, " ")
      // Remove markdown-ish wrappers at the edges.
      .replace(/^[*`~_]+/, "")
      .replace(/[*`~_]+$/, "");

  const trimmedNormalized = stripMarkup(trimmed);
  const hasToken = trimmed.includes(HEARTBEAT_TOKEN) || trimmedNormalized.includes(HEARTBEAT_TOKEN);
  if (!hasToken) {
    return { shouldSkip: false, text: trimmed, didStrip: false };
  }

  const strippedOriginal = stripTokenAtEdges(trimmed);
  const strippedNormalized = stripTokenAtEdges(trimmedNormalized);
  const picked =
    strippedOriginal.didStrip && strippedOriginal.text ? strippedOriginal : strippedNormalized;
  if (!picked.didStrip) {
    return { shouldSkip: false, text: trimmed, didStrip: false };
  }

  if (!picked.text) {
    return { shouldSkip: true, text: "", didStrip: true };
  }

  const rest = picked.text.trim();
  if (mode === "heartbeat") {
    if (rest.length <= maxAckChars) {
      return { shouldSkip: true, text: "", didStrip: true };
    }
  }

  return { shouldSkip: false, text: rest, didStrip: true };
}

/**
 * Parse heartbeat tasks from HEARTBEAT.md content.
 * Supports YAML-like task definitions:
 *
 * tasks:
 *   - name: email-check
 *     interval: 30m
 *     prompt: "Check for urgent unread emails"
 */
export function parseHeartbeatTasks(content: string): HeartbeatTask[] {
  const tasks: HeartbeatTask[] = [];
  const lines = content.split("\n");
  let inTasksBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Detect tasks block start
    if (trimmed === "tasks:") {
      inTasksBlock = true;
      continue;
    }

    if (!inTasksBlock) {
      continue;
    }

    // End of tasks block (either empty line or new top-level content)
    // Don't exit for task fields (interval:, prompt:, - name:)
    const isTaskField =
      trimmed.startsWith("interval:") ||
      trimmed.startsWith("prompt:") ||
      trimmed.startsWith("- name:");
    if (
      !isTaskField &&
      !trimmed.startsWith(" ") &&
      !trimmed.startsWith("\t") &&
      trimmed &&
      !trimmed.startsWith("-")
    ) {
      inTasksBlock = false;
      continue;
    }

    // Parse task entry
    if (trimmed.startsWith("- name:")) {
      const name = trimmed
        .replace("- name:", "")
        .trim()
        .replace(/^["']|["']$/g, "");
      let interval = "";
      let prompt = "";

      // Look ahead for interval and prompt
      for (let j = i + 1; j < lines.length; j++) {
        const nextLine = lines[j];
        const nextTrimmed = nextLine.trim();

        // End of this task
        if (nextTrimmed.startsWith("- name:")) {
          break;
        }

        // Check for task fields BEFORE checking for end of block
        if (nextTrimmed.startsWith("interval:")) {
          interval = nextTrimmed
            .replace("interval:", "")
            .trim()
            .replace(/^["']|["']$/g, "");
        } else if (nextTrimmed.startsWith("prompt:")) {
          prompt = nextTrimmed
            .replace("prompt:", "")
            .trim()
            .replace(/^["']|["']$/g, "");
        } else if (!nextTrimmed.startsWith(" ") && !nextTrimmed.startsWith("\t") && nextTrimmed) {
          // End of tasks block
          inTasksBlock = false;
          break;
        }
      }

      if (name && interval && prompt) {
        tasks.push({ name, interval, prompt });
      }
    }
  }

  return tasks;
}

/**
 * Check if a task is due based on its interval and last run time.
 */
export function isTaskDue(lastRunMs: number | undefined, interval: string, nowMs: number): boolean {
  if (lastRunMs === undefined) {
    return true; // Never run, always due
  }

  try {
    const intervalMs = parseDurationMs(interval, { defaultUnit: "m" });
    return nowMs - lastRunMs >= intervalMs;
  } catch {
    return false;
  }
}
