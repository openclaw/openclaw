/**
 * Sessions CLI - Manage session transcripts and session store
 * 
 * Provides commands for:
 * - Repairing sessions.json from orphaned .jsonl files
 * - Rebuilding session store from disk
 * - Inspecting and managing session transcripts
 */

import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import { defaultRuntime } from "../runtime.js";
import { formatHelpExamples } from "./help-format.js";
import { theme } from "../terminal/theme.js";
import { shortenHomePath } from "../utils.js";

type SessionsCommandOptions = {
  agent?: string;
  json?: boolean;
  verbose?: boolean;
  dryRun?: boolean;
};

type SessionMetadata = {
  sessionId: string;
  timestamp?: string;
  updatedAt: number;
};

type SessionEntry = {
  sessionId: string;
  updatedAt: number;
  systemSent: boolean;
  abortedLastRun: boolean;
  chatType: string;
  deliveryContext: {
    channel: string;
  };
  lastChannel: string;
  origin: {
    provider: string;
    surface: string;
    chatType: string;
  };
  sessionFile: string;
  compactionCount: number;
  skillsSnapshot: {
    prompt: string;
    skills: Array<{ name: string }>;
  };
  recovered?: boolean;
  recoveredAt?: string;
};

type SessionsJson = Record<string, SessionEntry>;

type RepairStats = {
  scanned: number;
  registered: number;
  alreadyTracked: number;
  invalid: number;
  backup?: string;
};

/**
 * Load sessions.json from the sessions directory
 */
async function loadSessionsJson(sessionsDir: string): Promise<SessionsJson> {
  const sessionsFile = path.join(sessionsDir, "sessions.json");
  try {
    await fs.access(sessionsFile, fsSync.constants.R_OK);
    const content = await fs.readFile(sessionsFile, "utf-8");
    return JSON.parse(content) as SessionsJson;
  } catch {
    return {};
  }
}

/**
 * Save sessions.json to the sessions directory
 */
async function saveSessionsJson(sessionsDir: string, sessions: SessionsJson): Promise<void> {
  const sessionsFile = path.join(sessionsDir, "sessions.json");
  const content = JSON.stringify(sessions, null, 2);
  await fs.writeFile(sessionsFile, content, "utf-8");
}

/**
 * Create a backup of sessions.json
 */
async function createBackup(sessionsDir: string): Promise<string | null> {
  const sessionsFile = path.join(sessionsDir, "sessions.json");
  try {
    await fs.access(sessionsFile, fsSync.constants.R_OK);
  } catch {
    return null;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
  const backupFile = path.join(sessionsDir, `sessions.json.backup.${timestamp}`);
  await fs.copyFile(sessionsFile, backupFile);
  return backupFile;
}

/**
 * Extract session metadata from the first line of a .jsonl file
 */
async function extractSessionMetadata(jsonlFile: string): Promise<SessionMetadata | null> {
  try {
    const file = await fs.open(jsonlFile, "r");
    try {
      const buffer = Buffer.alloc(8192);
      const { bytesRead } = await file.read(buffer);
      
      if (bytesRead === 0) {
        return null;
      }

      const firstLine = buffer.toString("utf-8", 0, bytesRead).split("\n")[0].trim();
      if (!firstLine) {
        return null;
      }

      const data = JSON.parse(firstLine);
      
      // Validate this is a session header
      if (data.type !== "session") {
        return null;
      }

      const sessionId = data.id;
      const timestamp = data.timestamp;
      
      if (!sessionId) {
        return null;
      }

      // Parse timestamp to get updatedAt
      let updatedAt = Date.now();
      if (timestamp) {
        const dt = new Date(timestamp);
        if (!isNaN(dt.getTime())) {
          updatedAt = dt.getTime();
        }
      }

      return {
        sessionId,
        timestamp,
        updatedAt,
      };
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}

/**
 * Generate a session key for sessions.json
 */
function generateSessionKey(sessionId: string): string {
  return `agent:main:recovered:${sessionId}`;
}

/**
 * Build a session entry for sessions.json
 */
function buildSessionEntry(
  metadata: SessionMetadata,
  jsonlFile: string,
): SessionEntry {
  return {
    sessionId: metadata.sessionId,
    updatedAt: metadata.updatedAt,
    systemSent: false,
    abortedLastRun: false,
    chatType: "direct",
    deliveryContext: {
      channel: "unknown",
    },
    lastChannel: "unknown",
    origin: {
      provider: "unknown",
      surface: "unknown",
      chatType: "direct",
    },
    sessionFile: path.resolve(jsonlFile),
    compactionCount: 0,
    skillsSnapshot: {
      prompt: "",
      skills: [],
    },
    recovered: true,
    recoveredAt: new Date().toISOString(),
  };
}

/**
 * Scan the sessions directory for all .jsonl files
 */
async function scanJsonlFiles(sessionsDir: string): Promise<Array<{ file: string; metadata: SessionMetadata }>> {
  const results: Array<{ file: string; metadata: SessionMetadata }> = [];
  
  try {
    const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
    
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }

      // Skip backup/reset/deleted files
      if (entry.name.includes(".reset.") || 
          entry.name.includes(".deleted.") || 
          entry.name.includes(".backup.")) {
        continue;
      }

      const jsonlFile = path.join(sessionsDir, entry.name);
      const metadata = await extractSessionMetadata(jsonlFile);
      
      if (metadata) {
        results.push({ file: jsonlFile, metadata });
      }
    }
  } catch {
    // Directory not accessible
  }

  return results;
}

/**
 * Check if a session is already tracked in sessions.json
 */
function isSessionTracked(
  sessions: SessionsJson,
  sessionId: string,
  jsonlFile: string,
): boolean {
  const absolutePath = path.resolve(jsonlFile);
  
  for (const entry of Object.values(sessions)) {
    if (entry.sessionId === sessionId) {
      return true;
    }
    if (path.resolve(entry.sessionFile) === absolutePath) {
      return true;
    }
  }
  
  return false;
}

/**
 * Repair sessions.json by scanning for orphaned .jsonl files
 */
async function repairSessions(
  sessionsDir: string,
  options: { dryRun?: boolean; verbose?: boolean },
): Promise<RepairStats> {
  const stats: RepairStats = {
    scanned: 0,
    registered: 0,
    alreadyTracked: 0,
    invalid: 0,
  };

  // Load existing sessions
  const sessions = await loadSessionsJson(sessionsDir);

  // Create backup before modifying
  if (!options.dryRun && Object.keys(sessions).length > 0) {
    const backupPath = await createBackup(sessionsDir);
    if (backupPath && options.verbose) {
      defaultRuntime.log(theme.info(`Created backup: ${shortenHomePath(backupPath)}`));
    }
    stats.backup = backupPath ?? undefined;
  }

  // Scan for .jsonl files
  const jsonlFiles = await scanJsonlFiles(sessionsDir);
  stats.scanned = jsonlFiles.length;

  if (options.verbose) {
    defaultRuntime.log(theme.info(`Found ${jsonlFiles.length} .jsonl files`));
  }

  // Process each file
  for (const { file, metadata } of jsonlFiles) {
    const sessionId = metadata.sessionId;

    // Check if already tracked
    if (isSessionTracked(sessions, sessionId, file)) {
      stats.alreadyTracked++;
      if (options.verbose) {
        defaultRuntime.log(`  ${theme.dim("Already tracked:")} ${path.basename(file)}`);
      }
      continue;
    }

    // Generate session key and entry
    let sessionKey = generateSessionKey(sessionId);
    const sessionEntry = buildSessionEntry(metadata, file);

    // Handle key collision
    let counter = 1;
    while (sessionKey in sessions) {
      sessionKey = `${generateSessionKey(sessionId)}.${counter}`;
      counter++;
    }

    // Add to sessions
    sessions[sessionKey] = sessionEntry;
    stats.registered++;

    if (options.verbose) {
      defaultRuntime.log(`  ${theme.success("Registered:")} ${path.basename(file)} → ${sessionKey}`);
    }
  }

  // Save if not dry-run
  if (!options.dryRun) {
    await saveSessionsJson(sessionsDir, sessions);
  }

  return stats;
}

/**
 * Format repair stats for output
 */
function formatRepairStats(stats: RepairStats, json?: boolean): string {
  if (json) {
    return JSON.stringify(stats, null, 2);
  }

  const lines = [
    "",
    theme.header("=== Repair Summary ==="),
    `Files scanned: ${theme.bold(stats.scanned.toString())}`,
    `Already tracked: ${theme.bold(stats.alreadyTracked.toString())}`,
    `Newly registered: ${theme.bold(stats.registered.toString())}`,
  ];

  if (stats.backup) {
    lines.push(`Backup created: ${theme.dim(shortenHomePath(stats.backup))}`);
  }

  return lines.join("\n");
}

/**
 * Register the sessions CLI commands
 */
export function registerSessionsCli(program: Command): void {
  const sessionsCmd = program
    .command("sessions")
    .description("Manage session transcripts and session store")
    .option("--agent <agent>", "Agent ID (default: main)")
    .option("--json", "Output as JSON")
    .option("--verbose", "Verbose output");

  // Repair subcommand
  sessionsCmd
    .command("repair")
    .description("Repair sessions.json by scanning for orphaned .jsonl files")
    .option("--dry-run", "Preview changes without modifying sessions.json")
    .action(async (cmdOptions: SessionsCommandOptions) => {
      const options = sessionsCmd.opts<SessionsCommandOptions>();
      const cfg = loadConfig();
      const agentId = options.agent ?? resolveDefaultAgentId(cfg);
      const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);

      if (options.verbose) {
        defaultRuntime.log(theme.info(`Sessions directory: ${shortenHomePath(sessionsDir)}`));
        defaultRuntime.log(theme.info(`Dry run: ${cmdOptions.dryRun ? "yes" : "no"}`));
      }

      try {
        // Check if directory exists
        try {
          await fs.access(sessionsDir, fsSync.constants.R_OK);
        } catch {
          defaultRuntime.error(theme.error(`Sessions directory not found: ${shortenHomePath(sessionsDir)}`));
          process.exit(1);
        }

        const stats = await repairSessions(sessionsDir, {
          dryRun: cmdOptions.dryRun ?? false,
          verbose: options.verbose ?? false,
        });

        defaultRuntime.log(formatRepairStats(stats, options.json));

        if (cmdOptions.dryRun) {
          defaultRuntime.log("");
          defaultRuntime.log(theme.warn("NOTE: This was a dry run. No changes were made."));
          defaultRuntime.log(theme.warn("Run without --dry-run to apply changes."));
        }
      } catch (error) {
        defaultRuntime.error(theme.error(`Repair failed: ${error instanceof Error ? error.message : String(error)}`));
        process.exit(1);
      }
    });

  // Rebuild subcommand (alias for repair)
  sessionsCmd
    .command("rebuild")
    .description("Alias for 'repair' - rebuild sessions.json from disk")
    .option("--dry-run", "Preview changes without modifying sessions.json")
    .action(async (cmdOptions: SessionsCommandOptions) => {
      // Reuse repair logic
      const options = sessionsCmd.opts<SessionsCommandOptions>();
      const cfg = loadConfig();
      const agentId = options.agent ?? resolveDefaultAgentId(cfg);
      const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);

      try {
        const stats = await repairSessions(sessionsDir, {
          dryRun: cmdOptions.dryRun ?? false,
          verbose: options.verbose ?? false,
        });
        defaultRuntime.log(formatRepairStats(stats, options.json));
      } catch (error) {
        defaultRuntime.error(theme.error(`Rebuild failed: ${error instanceof Error ? error.message : String(error)}`));
        process.exit(1);
      }
    });

  // Status subcommand
  sessionsCmd
    .command("status")
    .description("Show session store status")
    .action(async () => {
      const options = sessionsCmd.opts<SessionsCommandOptions>();
      const cfg = loadConfig();
      const agentId = options.agent ?? resolveDefaultAgentId(cfg);
      const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);

      try {
        const sessions = await loadSessionsJson(sessionsDir);
        const jsonlFiles = await scanJsonlFiles(sessionsDir);

        const result = {
          agentId,
          sessionsDir: shortenHomePath(sessionsDir),
          registeredSessions: Object.keys(sessions).length,
          jsonlFilesOnDisk: jsonlFiles.length,
          orphanedFiles: jsonlFiles.filter(
            ({ metadata }) => !isSessionTracked(sessions, metadata.sessionId, metadata.sessionId),
          ).length,
        };

        if (options.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
        } else {
          defaultRuntime.log(theme.header("=== Session Store Status ==="));
          defaultRuntime.log(`Agent: ${theme.bold(result.agentId)}`);
          defaultRuntime.log(`Directory: ${theme.dim(result.sessionsDir)}`);
          defaultRuntime.log(`Registered sessions: ${theme.bold(result.registeredSessions.toString())}`);
          defaultRuntime.log(`.jsonl files on disk: ${theme.bold(result.jsonlFilesOnDisk.toString())}`);
          defaultRuntime.log(`Orphaned files: ${theme.bold(result.orphanedFiles.toString())}`);
          
          if (result.orphanedFiles > 0) {
            defaultRuntime.log("");
            defaultRuntime.log(theme.warn(`Run 'openclaw sessions repair' to register ${result.orphanedFiles} orphaned file(s)`));
          }
        }
      } catch (error) {
        defaultRuntime.error(theme.error(`Status failed: ${error instanceof Error ? error.message : String(error)}`));
        process.exit(1);
      }
    });

  // Add examples
  sessionsCmd.addHelpText(
    "after",
    formatHelpExamples([
      "openclaw sessions status",
      "openclaw sessions repair --dry-run",
      "openclaw sessions repair --verbose",
      "openclaw sessions rebuild",
      "openclaw sessions status --json",
    ]),
  );
}
