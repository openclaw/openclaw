import fs from "node:fs";
import type { OpenClawConfig } from "../config/config.js";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveStateDir } from "../config/paths.js";
import { findSessionFiles } from "../gateway/session-utils.fs.js";
import { getDefaultRedactPatterns } from "../logging/redact.js";
import { note } from "../terminal/note.js";

/**
 * Deterministic sample: sort paths and take first N for stable, reproducible results.
 * Avoids nondeterministic "flapping" warnings across runs.
 */
function deterministicSample(array: string[], n: number): string[] {
  return [...array].toSorted((a, b) => a.localeCompare(b)).slice(0, n);
}

async function scanFileForSecrets(
  filePath: string,
  patterns: RegExp[],
): Promise<{ matchCount: number; error?: boolean }> {
  try {
    const content = await fs.promises.readFile(filePath, "utf-8");
    let count = 0;
    for (const pattern of patterns) {
      if (!pattern.source) {
        continue; // skip empty patterns
      }
      const matches = content.match(
        new RegExp(pattern.source, pattern.flags.replace("g", "") + "g"),
      );
      if (matches) {
        count += matches.filter((m) => m.length > 0).length;
        // Early termination: we know this file has secrets, no need to check
        // remaining patterns. Exact count isn't critical for diagnostics.
        break;
      }
    }
    return { matchCount: count };
  } catch {
    return { matchCount: 0, error: true };
  }
}

/** Parse a single redact pattern string into a RegExp (mirrors redact.ts logic). */
function parsePattern(raw: string): RegExp | null {
  if (!raw.trim()) {
    return null;
  }
  const match = raw.match(/^\/(.+)\/([gimsuy]*)$/);
  try {
    if (match) {
      const flags = match[2].includes("g") ? match[2] : `${match[2]}g`;
      return new RegExp(match[1], flags);
    }
    return new RegExp(raw, "gi");
  } catch {
    return null;
  }
}

function compilePatterns(patterns: string[]): RegExp[] {
  return patterns.map(parsePattern).filter((re): re is RegExp => re !== null);
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

  // Scan all files if <=200, otherwise deterministically sample 200 (sorted, first N) to avoid long delays
  const sampled = files.length > 200 ? deterministicSample(files, 200) : files;
  const sampleSize = sampled.length;

  for (const file of sampled) {
    const result = await scanFileForSecrets(file, patterns);
    if (result.error) {
      readErrors++;
    } else if (result.matchCount > 0) {
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
    const sampledNote = files.length > 200 ? " (deterministic sample)" : "";
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
    const sampledNote = files.length > 200 ? " (deterministic sample)" : "";
    warnings.push(
      `- Scanned ${sampleSize} session file(s)${sampledNote} — no unredacted secrets detected. ✓`,
    );
    warnings.push(
      `  This is a basic pattern check. Run ${formatCliCommand("openclaw sessions scrub --dry-run")} for thorough analysis.`,
    );
  }

  note(warnings.join("\n"), "Session Secrets");
}
