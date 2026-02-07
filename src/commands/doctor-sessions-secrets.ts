import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveStateDir } from "../config/paths.js";
import { getDefaultRedactPatterns } from "../logging/redact.js";
import { note } from "../terminal/note.js";

async function findSessionFiles(stateDir: string): Promise<string[]> {
  const agentsDir = path.join(stateDir, "agents");
  if (!fs.existsSync(agentsDir)) {
    return [];
  }

  const files: string[] = [];
  try {
    const agentDirs = await fs.promises.readdir(agentsDir, { withFileTypes: true });

    for (const agentDir of agentDirs) {
      if (!agentDir.isDirectory()) {
        continue;
      }
      const sessionsDir = path.join(agentsDir, agentDir.name, "sessions");
      if (!fs.existsSync(sessionsDir)) {
        continue;
      }

      const sessionFiles = await fs.promises.readdir(sessionsDir);
      for (const file of sessionFiles) {
        if (file.endsWith(".jsonl")) {
          files.push(path.join(sessionsDir, file));
        }
      }
    }
  } catch {
    // Silently skip if we can't read the directory
  }

  return files;
}

async function scanFileForSecrets(filePath: string, patterns: RegExp[]): Promise<boolean> {
  try {
    const content = await fs.promises.readFile(filePath, "utf-8");
    for (const pattern of patterns) {
      // Reset lastIndex for global regexps
      pattern.lastIndex = 0;
      if (pattern.test(content)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
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

  // Scan a sample of files to avoid long delays
  const sampleSize = Math.min(files.length, 50);
  const sampled = files.slice(0, sampleSize);

  for (const file of sampled) {
    if (await scanFileForSecrets(file, patterns)) {
      filesWithSecrets++;
    }
  }

  const warnings: string[] = [];

  if (filesWithSecrets > 0) {
    const percentage = Math.round((filesWithSecrets / sampleSize) * 100);
    warnings.push(
      `- Found unredacted secrets in ${filesWithSecrets} of ${sampleSize} session files scanned (~${percentage}%).`,
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
    warnings.push(
      `- Scanned ${sampleSize} session file(s), no obvious unredacted secrets detected.`,
    );
    warnings.push(
      `  This is a basic pattern check. Run ${formatCliCommand("openclaw sessions scrub --dry-run")} for thorough analysis.`,
    );
  }

  note(warnings.join("\n"), "Session Secrets");
}
