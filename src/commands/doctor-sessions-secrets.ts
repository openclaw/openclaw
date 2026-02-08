import fs from "node:fs";
import type { OpenClawConfig } from "../config/config.js";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveStateDir } from "../config/paths.js";
import { findSessionFiles } from "../gateway/session-utils.fs.js";
import { getDefaultRedactPatterns } from "../logging/redact.js";
import { note } from "../terminal/note.js";

/**
 * Randomly shuffle an array using Fisher-Yates algorithm.
 */
function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

async function scanFileForSecrets(
  filePath: string,
  patterns: RegExp[],
): Promise<{ match: boolean; error?: boolean }> {
  try {
    const content = await fs.promises.readFile(filePath, "utf-8");
    for (const pattern of patterns) {
      // Reset lastIndex for global regexps
      pattern.lastIndex = 0;
      if (pattern.test(content)) {
        return { match: true };
      }
    }
    return { match: false };
  } catch {
    return { match: false, error: true };
  }
}

function compilePatterns(patterns: string[]): RegExp[] {
  return patterns
    .map((pattern) => {
      try {
        // All patterns should have global flag for proper testing
        const hasGlobalFlag = pattern.match(/\/([gimsuy]*)$/)?.[1]?.includes("g");
        if (pattern.startsWith("/") && pattern.includes("/", 1)) {
          const match = pattern.match(/^\/(.+)\/([gimsuy]*)$/);
          if (match) {
            const flags = hasGlobalFlag ? match[2] : `${match[2]}g`;
            return new RegExp(match[1], flags);
          }
        }
        return new RegExp(pattern, "gi");
      } catch {
        return null;
      }
    })
    .filter((re): re is RegExp => re !== null);
}

export async function noteSessionSecretsWarnings(_cfg?: OpenClawConfig): Promise<void> {
  const stateDir = resolveStateDir();
  const files = await findSessionFiles(stateDir);

  if (files.length === 0) {
    note("- No session files found.", "Session Secrets");
    return;
  }

  const patterns = compilePatterns(getDefaultRedactPatterns());
  let filesWithSecrets = 0;
  let readErrors = 0;

  // Scan all files if <=200, otherwise sample 200 randomly to avoid long delays
  const sampled = files.length > 200 ? shuffleArray(files).slice(0, 200) : files;
  const sampleSize = sampled.length;

  for (const file of sampled) {
    const result = await scanFileForSecrets(file, patterns);
    if (result.error) {
      readErrors++;
    } else if (result.match) {
      filesWithSecrets++;
    }
  }

  const warnings: string[] = [];

  if (readErrors > 0) {
    warnings.push(
      `- ⚠ Could not read ${readErrors} session file(s) — these were not checked for secrets.`,
    );
  }

  if (filesWithSecrets > 0) {
    const percentage = Math.round((filesWithSecrets / sampleSize) * 100);
    const sampledNote = files.length > 200 ? " (random sample)" : "";
    warnings.push(
      `- Found unredacted secrets in ${filesWithSecrets} of ${sampleSize} session files scanned${sampledNote} (~${percentage}%).`,
    );
    warnings.push(
      `  Session transcripts may contain API keys, tokens, or passwords from tool calls.`,
    );
    warnings.push("");
    warnings.push(`  Fix: ${formatCliCommand("openclaw sessions scrub")}`);
    warnings.push(`  Dry run: ${formatCliCommand("openclaw sessions scrub --dry-run")}`);
    warnings.push("");
    warnings.push("  Note: Runtime redaction is already enabled (read-time protection).");
    warnings.push("  The scrub command provides at-rest scrubbing for historical sessions.");
  } else {
    const sampledNote = files.length > 200 ? " (random sample)" : "";
    warnings.push(
      `- Scanned ${sampleSize} session file(s)${sampledNote}, no obvious unredacted secrets detected.`,
    );
    warnings.push(
      `  This is a basic pattern check. Run ${formatCliCommand("openclaw sessions scrub --dry-run")} for thorough analysis.`,
    );
  }

  note(warnings.join("\n"), "Session Secrets");
}
