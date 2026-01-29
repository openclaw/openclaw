import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import { info, warn } from "../globals.js";
import type { RuntimeEnv } from "../runtime.js";
import { isRich, theme } from "../terminal/theme.js";
import { VERSION } from "../version.js";

export type BackupCreateOptions = {
  output?: string;
  includeCredentials?: boolean;
  json?: boolean;
};

export type BackupRestoreOptions = {
  input: string;
  dryRun?: boolean;
  json?: boolean;
};

export type BackupExportOptions = {
  format?: "markdown" | "json" | "jsonl";
  output?: string;
  agent?: string;
  session?: string;
  since?: string;
};

type BackupManifest = {
  version: string;
  createdAt: string;
  hostname: string;
  platform: string;
  stateDir: string;
  configPath: string;
  includesCredentials: boolean;
  files: BackupFileEntry[];
};

type BackupFileEntry = {
  relativePath: string;
  size: number;
  sha256: string;
};

const BACKUP_MANIFEST = "backup-manifest.json";

function hashFile(filePath: string): string {
  const data = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
}

async function collectFiles(
  dir: string,
  baseDir: string,
  excludePatterns: string[] = [],
): Promise<{ relativePath: string; absolutePath: string }[]> {
  const results: { relativePath: string; absolutePath: string }[] = [];
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absPath = path.join(dir, entry.name);
      const relPath = path.relative(baseDir, absPath);

      // Skip excluded patterns
      if (excludePatterns.some((p) => relPath.includes(p) || entry.name === p)) {
        continue;
      }

      if (entry.isDirectory()) {
        const subFiles = await collectFiles(absPath, baseDir, excludePatterns);
        results.push(...subFiles);
      } else if (entry.isFile()) {
        results.push({ relativePath: relPath, absolutePath: absPath });
      }
    }
  } catch {
    // skip inaccessible directories
  }
  return results;
}

export async function backupCreateCommand(
  opts: BackupCreateOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const stateDir = resolveStateDir();
  const configPath = resolveConfigPath();
  const includeCredentials = opts.includeCredentials ?? false;

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const defaultOutput = path.join(os.homedir(), `moltbot-backup-${timestamp}`);
  const outputDir = opts.output ?? defaultOutput;

  if (!opts.json) {
    runtime.log(info("Creating backup..."));
    runtime.log(info(`State dir: ${stateDir}`));
    runtime.log(info(`Output: ${outputDir}`));
  }

  // Collect files to backup
  const excludePatterns = [
    ".lock",
    ".tmp",
    "node_modules",
    ".git",
    "cache",
  ];
  if (!includeCredentials) {
    excludePatterns.push("credentials");
  }

  const files = await collectFiles(stateDir, stateDir, excludePatterns);

  // Also include the config file if it's outside the state dir
  const configInStateDir = configPath.startsWith(stateDir);
  if (!configInStateDir && fs.existsSync(configPath)) {
    files.push({
      relativePath: path.basename(configPath),
      absolutePath: configPath,
    });
  }

  // Create output directory
  await fs.promises.mkdir(outputDir, { recursive: true });

  // Copy files
  const manifest: BackupManifest = {
    version: VERSION,
    createdAt: new Date().toISOString(),
    hostname: os.hostname(),
    platform: process.platform,
    stateDir,
    configPath,
    includesCredentials: includeCredentials,
    files: [],
  };

  let totalSize = 0;
  for (const file of files) {
    const destPath = path.join(outputDir, file.relativePath);
    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
    await fs.promises.copyFile(file.absolutePath, destPath);

    const stat = await fs.promises.stat(file.absolutePath);
    const sha256 = hashFile(file.absolutePath);
    manifest.files.push({
      relativePath: file.relativePath,
      size: stat.size,
      sha256,
    });
    totalSize += stat.size;
  }

  // Write manifest
  await fs.promises.writeFile(
    path.join(outputDir, BACKUP_MANIFEST),
    JSON.stringify(manifest, null, 2),
    "utf-8",
  );

  const fileSizeLabel = formatBytes(totalSize);

  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          output: outputDir,
          fileCount: manifest.files.length,
          totalSize,
          totalSizeLabel: fileSizeLabel,
          includesCredentials: includeCredentials,
          manifest,
        },
        null,
        2,
      ),
    );
    return;
  }

  const rich = isRich();
  runtime.log("");
  runtime.log(
    rich
      ? theme.success(`Backup created: ${outputDir}`)
      : `Backup created: ${outputDir}`,
  );
  runtime.log(info(`Files: ${manifest.files.length}`));
  runtime.log(info(`Size: ${fileSizeLabel}`));
  runtime.log(info(`Credentials: ${includeCredentials ? "included" : "excluded"}`));
  if (!includeCredentials) {
    runtime.log(warn("Tip: Use --include-credentials to include API keys and tokens."));
  }
}

export async function backupRestoreCommand(
  opts: BackupRestoreOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const inputDir = path.resolve(opts.input);
  const manifestPath = path.join(inputDir, BACKUP_MANIFEST);

  if (!fs.existsSync(manifestPath)) {
    runtime.error(`Not a valid backup: missing ${BACKUP_MANIFEST} at ${inputDir}`);
    return;
  }

  const manifest = JSON.parse(
    fs.readFileSync(manifestPath, "utf-8"),
  ) as BackupManifest;

  runtime.log(info(`Restoring backup from: ${inputDir}`));
  runtime.log(info(`Backup version: ${manifest.version}`));
  runtime.log(info(`Created: ${manifest.createdAt}`));
  runtime.log(info(`Files: ${manifest.files.length}`));
  runtime.log(info(`Includes credentials: ${manifest.includesCredentials}`));

  const stateDir = resolveStateDir();

  if (opts.dryRun) {
    runtime.log("");
    runtime.log(info("Dry run - files that would be restored:"));
    for (const file of manifest.files) {
      const destPath = path.join(stateDir, file.relativePath);
      const exists = fs.existsSync(destPath);
      runtime.log(`  ${exists ? "overwrite" : "create"}: ${file.relativePath} (${formatBytes(file.size)})`);
    }
    return;
  }

  // Verify file integrity
  let integrityOk = true;
  for (const file of manifest.files) {
    const srcPath = path.join(inputDir, file.relativePath);
    if (!fs.existsSync(srcPath)) {
      runtime.error(`Missing file in backup: ${file.relativePath}`);
      integrityOk = false;
      continue;
    }
    const sha256 = hashFile(srcPath);
    if (sha256 !== file.sha256) {
      runtime.error(`Integrity check failed for: ${file.relativePath}`);
      integrityOk = false;
    }
  }

  if (!integrityOk) {
    runtime.error("Backup integrity check failed. Aborting restore.");
    return;
  }

  // Restore files
  let restored = 0;
  for (const file of manifest.files) {
    const srcPath = path.join(inputDir, file.relativePath);
    const destPath = path.join(stateDir, file.relativePath);
    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
    await fs.promises.copyFile(srcPath, destPath);
    restored++;
  }

  runtime.log("");
  runtime.log(
    isRich()
      ? theme.success(`Restored ${restored} file(s) to ${stateDir}`)
      : `Restored ${restored} file(s) to ${stateDir}`,
  );
}

export async function backupExportCommand(
  opts: BackupExportOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const stateDir = resolveStateDir();
  const agentsDir = path.join(stateDir, "agents");
  const format = opts.format ?? "markdown";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const ext = format === "markdown" ? "md" : format;
  const outputPath = opts.output ?? path.join(os.homedir(), `moltbot-export-${timestamp}.${ext}`);

  const sinceMs = opts.since ? parseSinceForExport(opts.since) : null;
  const agentFilter = opts.agent;
  const sessionFilter = opts.session;

  runtime.log(info(`Exporting conversations as ${format}...`));

  // Collect transcript files
  type TranscriptInfo = {
    agentId: string;
    sessionKey: string;
    filePath: string;
  };
  const transcripts: TranscriptInfo[] = [];

  try {
    const agents = await fs.promises.readdir(agentsDir, { withFileTypes: true });
    for (const agentEntry of agents) {
      if (!agentEntry.isDirectory()) continue;
      if (agentFilter && agentEntry.name !== agentFilter) continue;

      const sessionsDir = path.join(agentsDir, agentEntry.name, "sessions");
      try {
        const files = await fs.promises.readdir(sessionsDir, { withFileTypes: true });
        for (const file of files) {
          if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
          const sessionKey = file.name.replace(/\.jsonl$/, "");
          if (sessionFilter && sessionKey !== sessionFilter) continue;

          transcripts.push({
            agentId: agentEntry.name,
            sessionKey,
            filePath: path.join(sessionsDir, file.name),
          });
        }
      } catch {
        // no sessions dir
      }
    }
  } catch {
    runtime.error("No agents directory found.");
    return;
  }

  if (transcripts.length === 0) {
    runtime.log("No transcripts to export.");
    return;
  }

  const outputParts: string[] = [];

  for (const transcript of transcripts) {
    const messages = await readTranscriptMessages(transcript.filePath, sinceMs);
    if (messages.length === 0) continue;

    if (format === "markdown") {
      outputParts.push(`## ${transcript.agentId} / ${transcript.sessionKey}\n`);
      for (const msg of messages) {
        const ts = msg.timestamp ? `_${msg.timestamp}_` : "";
        outputParts.push(`**${msg.role}** ${ts}\n\n${msg.content}\n\n---\n`);
      }
    } else if (format === "json") {
      outputParts.push(
        JSON.stringify(
          {
            agentId: transcript.agentId,
            sessionKey: transcript.sessionKey,
            messages,
          },
          null,
          2,
        ),
      );
    } else {
      // jsonl
      for (const msg of messages) {
        outputParts.push(
          JSON.stringify({
            agentId: transcript.agentId,
            sessionKey: transcript.sessionKey,
            ...msg,
          }),
        );
      }
    }
  }

  const content =
    format === "json"
      ? JSON.stringify(JSON.parse(`[${outputParts.join(",")}]`), null, 2)
      : outputParts.join("\n");

  await fs.promises.writeFile(outputPath, content, "utf-8");
  runtime.log(
    isRich()
      ? theme.success(`Exported to: ${outputPath}`)
      : `Exported to: ${outputPath}`,
  );
  runtime.log(info(`Transcripts: ${transcripts.length}`));
}

// ── Helpers ──

type ParsedMessage = {
  role: string;
  content: string;
  timestamp?: string;
};

async function readTranscriptMessages(
  filePath: string,
  sinceMs: number | null,
): Promise<ParsedMessage[]> {
  const messages: ParsedMessage[] = [];
  const readline = await import("node:readline");
  const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      const role = String(entry.role ?? "unknown");
      const content = extractContent(entry);
      if (!content) continue;

      if (sinceMs !== null) {
        const ts = entry.timestamp ?? entry.ts ?? entry.createdAt;
        if (typeof ts === "number" && ts < sinceMs) continue;
        if (typeof ts === "string") {
          const tsMs = new Date(ts).getTime();
          if (!Number.isNaN(tsMs) && tsMs < sinceMs) continue;
        }
      }

      messages.push({
        role,
        content,
        timestamp: resolveTimestamp(entry),
      });
    } catch {
      // skip
    }
  }

  return messages;
}

function extractContent(entry: Record<string, unknown>): string {
  if (typeof entry.content === "string") return entry.content;
  if (Array.isArray(entry.content)) {
    return (entry.content as Array<Record<string, unknown>>)
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block.text === "string") return block.text;
        return "";
      })
      .filter(Boolean)
      .join(" ");
  }
  if (typeof entry.body === "string") return entry.body;
  if (typeof entry.text === "string") return entry.text;
  return "";
}

function resolveTimestamp(entry: Record<string, unknown>): string | undefined {
  const ts = entry.timestamp ?? entry.ts ?? entry.createdAt;
  if (typeof ts === "string") return ts;
  if (typeof ts === "number") return new Date(ts).toISOString();
  return undefined;
}

function parseSinceForExport(since: string): number | null {
  const match = since.match(/^(\d+)([mhd])$/);
  if (match) {
    const value = Number.parseInt(match[1], 10);
    const unit = match[2];
    const now = Date.now();
    if (unit === "m") return now - value * 60_000;
    if (unit === "h") return now - value * 3_600_000;
    if (unit === "d") return now - value * 86_400_000;
  }
  const parsed = new Date(since).getTime();
  if (!Number.isNaN(parsed)) return parsed;
  return null;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / k ** i;
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
