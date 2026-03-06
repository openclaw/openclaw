import fs from "node:fs";
import path from "node:path";
import { appendCronStyleCurrentTimeLine } from "../../agents/current-time.js";
import type { OpenClawConfig } from "../../config/config.js";
import { extractSections } from "./post-compaction-context.js";

const BARE_SESSION_RESET_PROMPT_BASE =
  "A new session was started via /new or /reset. Execute your Session Startup sequence now - read the required files before responding to the user. Then greet the user in your configured persona, if one is provided. Be yourself - use your defined voice, mannerisms, and mood. Keep it to 1-3 sentences and ask what they want to do. If the runtime model differs from default_model in the system prompt, mention the default model. Do not mention internal steps, files, tools, or reasoning.";

const MAX_STARTUP_SECTION_CHARS = 2000;

/**
 * Try to read the ## Session Startup section from AGENTS.md in the given workspace.
 * Returns the section content or null if not found.
 */
function readStartupSection(workspaceDir: string): string | null {
  const agentsPath = path.join(workspaceDir, "AGENTS.md");
  try {
    const content = fs.readFileSync(agentsPath, "utf-8");
    const sections = extractSections(content, ["Session Startup"]);
    if (sections.length === 0) {
      return null;
    }
    const combined = sections.join("\n\n");
    return combined.length > MAX_STARTUP_SECTION_CHARS
      ? combined.slice(0, MAX_STARTUP_SECTION_CHARS) + "\n...[truncated]..."
      : combined;
  } catch {
    return null;
  }
}

/**
 * Build the bare session reset prompt, appending the current date/time so agents
 * know which daily memory files to read during their Session Startup sequence.
 *
 * When workspaceDir is provided, the ## Session Startup section from AGENTS.md is
 * read and inlined directly into the prompt. This prevents models from hallucinating
 * file paths instead of following the actual configured startup instructions.
 */
export function buildBareSessionResetPrompt(
  cfg?: OpenClawConfig,
  nowMs?: number,
  workspaceDir?: string,
): string {
  let prompt = BARE_SESSION_RESET_PROMPT_BASE;

  if (workspaceDir) {
    const startupSection = readStartupSection(workspaceDir);
    if (startupSection) {
      prompt +=
        "\n\nYour Session Startup sequence (follow these steps exactly):\n\n" +
        startupSection;
    }
  }

  return appendCronStyleCurrentTimeLine(prompt, cfg ?? {}, nowMs ?? Date.now());
}

/** @deprecated Use buildBareSessionResetPrompt(cfg) instead */
export const BARE_SESSION_RESET_PROMPT = BARE_SESSION_RESET_PROMPT_BASE;
