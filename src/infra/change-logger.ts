/**
 * Change Logger Module for AI Agent Activity Tracking
 *
 * This module provides utilities for logging file changes made by AI agents
 * to a centralized change log in the second brain (myVault/15_ChangeLogs/).
 *
 * Usage:
 *   import { logChangeEntry, ChangeOperation } from './change-logger.js';
 *
 *   await logChangeEntry({
 *     agent: 'kilo-code',
 *     file: 'src/app.ts',
 *     operation: 'modify',
 *     lines: { start: 10, end: 25 },
 *     project: 'openclaw',
 *     reason: 'Fixed authentication bug'
 *   });
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Valid change operations
 */
export type ChangeOperation = 'create' | 'modify' | 'delete';

/**
 * Valid agent identifiers
 */
export type AgentId = 'kilo-code' | 'codex' | 'openclaw';

/**
 * Line range affected by the change
 */
export interface LineRange {
  /** Starting line number (1-based, inclusive) */
  start: number;
  /** Ending line number (1-based, inclusive) */
  end: number;
}

/**
 * Metadata for additional context
 */
export interface ChangeMetadata {
  /** Git commit hash if available */
  commitHash?: string;
  /** Related issue or PR number */
  issueRef?: string;
  /** Additional tags for categorization */
  tags?: string[];
  /** Extra arbitrary key-value pairs */
  [key: string]: unknown;
}

/**
 * Change log entry structure
 */
export interface ChangeLogEntry {
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Agent that made the change */
  agent: AgentId;
  /** Unique session identifier */
  sessionId: string;
  /** File path relative to project root */
  file: string;
  /** Type of operation performed */
  operation: ChangeOperation;
  /** Line numbers affected (optional) */
  lines?: LineRange;
  /** Project/repository name */
  project: string;
  /** Human-readable reason for the change */
  reason: string;
  /** Additional metadata (optional) */
  metadata?: ChangeMetadata;
}

/**
 * Configuration options for the change logger
 */
export interface ChangeLoggerConfig {
  /** Base path to the second brain (myVault) */
  myVaultPath: string;
  /** Current session ID */
  sessionId: string;
}

// Default configuration
const DEFAULT_CONFIG: ChangeLoggerConfig = {
  myVaultPath: join(homedir(), 'myVault'),
  sessionId: process.env.SESSION_ID || 'unknown-session',
};

// Module-level config that can be updated
let currentConfig: ChangeLoggerConfig = { ...DEFAULT_CONFIG };

/**
 * Initialize or update the change logger configuration
 */
export function initChangeLogger(config: Partial<ChangeLoggerConfig>): void {
  currentConfig = { ...currentConfig, ...config };
}

/**
 * Get the current configuration
 */
export function getChangeLoggerConfig(): ChangeLoggerConfig {
  return { ...currentConfig };
}

/**
 * Get the path to the current month's change log file
 */
export function getCurrentMonthLogPath(): string {
  const now = new Date();
  const yearMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  return join(currentConfig.myVaultPath, '15_ChangeLogs', `${yearMonth}.md`);
}

/**
 * Get the path to the change log directory
 */
export function getChangeLogDir(): string {
  return join(currentConfig.myVaultPath, '15_ChangeLogs');
}

/**
 * Format a change log entry as a markdown bullet point
 */
export function formatChangeEntry(entry: ChangeLogEntry): string {
  const lines = entry.lines
    ? ` (lines ${entry.lines.start}-${entry.lines.end})`
    : '';

  let output = `- **[${entry.timestamp}]** ${entry.agent} - ${entry.operation.toUpperCase()} \`${entry.file}\`${lines}\n`;
  output += `  - **Project:** ${entry.project}\n`;
  output += `  - **Reason:** ${entry.reason}\n`;

  if (entry.metadata && Object.keys(entry.metadata).length > 0) {
    output += `  - **Metadata:** ${JSON.stringify(entry.metadata)}\n`;
  }

  return output;
}

/**
 * Ensure the change log directory and current month file exist
 */
async function ensureChangeLogExists(): Promise<string> {
  const logDir = getChangeLogDir();
  const logPath = getCurrentMonthLogPath();

  // Ensure directory exists
  if (!existsSync(logDir)) {
    await mkdir(logDir, { recursive: true });
  }

  // Ensure current month file exists with header
  if (!existsSync(logPath)) {
    const now = new Date();
    const yearMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const header = `# Change Log - ${yearMonth}\n\n`;
    const description =
      '> This file tracks all file changes made by AI agents (Kilo Code, Codex, OpenClaw).\n' +
      '> Each entry includes timestamp, agent, file path, operation, and reason.\n\n';
    await writeFile(logPath, header + description, 'utf-8');
  }

  return logPath;
}

/**
 * Log a change entry to the change log
 *
 * @param entry - Partial entry (timestamp and sessionId are auto-populated)
 * @returns Promise that resolves when the entry is written
 *
 * @example
 * ```typescript
 * await logChangeEntry({
 *   agent: 'kilo-code',
 *   file: 'src/utils.ts',
 *   operation: 'modify',
 *   lines: { start: 10, end: 20 },
 *   project: 'my-project',
 *   reason: 'Refactored utility function'
 * });
 * ```
 */
export async function logChangeEntry(
  entry: Omit<ChangeLogEntry, 'timestamp' | 'sessionId'>,
): Promise<void> {
  const fullEntry: ChangeLogEntry = {
    timestamp: new Date().toISOString(),
    sessionId: currentConfig.sessionId,
    ...entry,
  };

  const logPath = await ensureChangeLogExists();
  const formattedEntry = formatChangeEntry(fullEntry);

  await appendFile(logPath, formattedEntry + '\n', 'utf-8');
}

/**
 * Log a file creation
 */
export async function logFileCreate(
  agent: AgentId,
  file: string,
  project: string,
  reason: string,
  metadata?: ChangeMetadata,
): Promise<void> {
  await logChangeEntry({
    agent,
    file,
    operation: 'create',
    project,
    reason,
    metadata,
  });
}

/**
 * Log a file modification
 */
export async function logFileModify(
  agent: AgentId,
  file: string,
  project: string,
  reason: string,
  lines?: LineRange,
  metadata?: ChangeMetadata,
): Promise<void> {
  await logChangeEntry({
    agent,
    file,
    operation: 'modify',
    lines,
    project,
    reason,
    metadata,
  });
}

/**
 * Log a file deletion
 */
export async function logFileDelete(
  agent: AgentId,
  file: string,
  project: string,
  reason: string,
  metadata?: ChangeMetadata,
): Promise<void> {
  await logChangeEntry({
    agent,
    file,
    operation: 'delete',
    project,
    reason,
    metadata,
  });
}

/**
 * Read recent change log entries
 *
 * @param limit - Maximum number of entries to read (default: 50)
 * @returns Array of parsed change log entries
 */
export async function readRecentEntries(limit = 50): Promise<ChangeLogEntry[]> {
  const logPath = getCurrentMonthLogPath();

  if (!existsSync(logPath)) {
    return [];
  }

  const content = await readFile(logPath, 'utf-8');
  const lines = content.split('\n');
  const entries: ChangeLogEntry[] = [];

  // Parse entries from markdown format
  // This is a simple parser - entries start with "- [**[timestamp]**]"
  let currentEntry: Partial<ChangeLogEntry> | null = null;

  for (const line of lines) {
    const entryMatch = line.match(
      /^-\s+\*\*\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]\*\*\s+(\S+)\s+-\s+(\w+)\s+`([^`]+)`/,
    );

    if (entryMatch) {
      if (currentEntry) {
        entries.push(currentEntry as ChangeLogEntry);
      }

      const [, timestamp, agent, operation, file] = entryMatch;
      const linesMatch = line.match(/\(lines (\d+)-(\d+)\)/);

      currentEntry = {
        timestamp,
        agent: agent as AgentId,
        operation: operation.toLowerCase() as ChangeOperation,
        file,
        sessionId: 'unknown',
        project: '',
        reason: '',
      };

      if (linesMatch) {
        currentEntry.lines = {
          start: parseInt(linesMatch[1], 10),
          end: parseInt(linesMatch[2], 10),
        };
      }
    } else if (currentEntry) {
      const projectMatch = line.match(/\*\*Project:\*\*\s+(.+)/);
      const reasonMatch = line.match(/\*\*Reason:\*\*\s+(.+)/);

      if (projectMatch) {
        currentEntry.project = projectMatch[1].trim();
      } else if (reasonMatch) {
        currentEntry.reason = reasonMatch[1].trim();
      }
    }
  }

  if (currentEntry) {
    entries.push(currentEntry as ChangeLogEntry);
  }

  // Return most recent entries first, limited to `limit`
  return entries.reverse().slice(0, limit);
}

/**
 * Get statistics about changes in the current month
 */
export async function getChangeStats(): Promise<{
  total: number;
  byAgent: Record<AgentId, number>;
  byOperation: Record<ChangeOperation, number>;
}> {
  const entries = await readRecentEntries(Number.POSITIVE_INFINITY);

  const stats = {
    total: entries.length,
    byAgent: {
      'kilo-code': 0,
      codex: 0,
      openclaw: 0,
    },
    byOperation: {
      create: 0,
      modify: 0,
      delete: 0,
    },
  };

  for (const entry of entries) {
    stats.byAgent[entry.agent]++;
    stats.byOperation[entry.operation]++;
  }

  return stats;
}
