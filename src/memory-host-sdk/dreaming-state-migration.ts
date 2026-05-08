import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { upsertPluginStateMigrationEntry } from "../plugin-sdk/migration-runtime.js";
import {
  createDreamingWorkspaceMapStorageEntry,
  createDreamingWorkspaceValueStorageEntry,
  createDreamingSessionCorpusLineStorageEntry,
  MEMORY_CORE_DAILY_INGESTION_STATE_NAMESPACE,
  MEMORY_CORE_PLUGIN_ID,
  MEMORY_CORE_SESSION_CORPUS_LINES_NAMESPACE,
  MEMORY_CORE_SESSION_INGESTION_FILES_NAMESPACE,
  MEMORY_CORE_SESSION_INGESTION_MESSAGES_NAMESPACE,
  MEMORY_CORE_SHORT_TERM_META_NAMESPACE,
  MEMORY_CORE_SHORT_TERM_PHASE_SIGNAL_NAMESPACE,
  MEMORY_CORE_SHORT_TERM_RECALL_NAMESPACE,
} from "./dreaming-state-store.js";
import { resolveMemoryDreamingWorkspaces } from "./dreaming.js";
import { importLegacyMemoryHostEventLogToSqlite, resolveMemoryHostEventLogPath } from "./events.js";

const DREAMING_STATE_RELATIVE_PATHS = {
  dailyIngestion: path.join("memory", ".dreams", "daily-ingestion.json"),
  sessionIngestion: path.join("memory", ".dreams", "session-ingestion.json"),
  shortTermRecall: path.join("memory", ".dreams", "short-term-recall.json"),
  phaseSignals: path.join("memory", ".dreams", "phase-signals.json"),
  events: path.join("memory", ".dreams", "events.jsonl"),
  sessionCorpusDir: path.join("memory", ".dreams", "session-corpus"),
  shortTermLock: path.join("memory", ".dreams", "short-term-promotion.lock"),
} as const;

type MigrationResult = {
  workspaces: number;
  files: number;
  rows: number;
  removedLocks: number;
  warnings: string[];
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function dirExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function readJsonIfExists(filePath: string): Promise<unknown> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw.trim() ? (JSON.parse(raw) as unknown) : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function createdAtFromRecord(record: Record<string, unknown> | undefined): number {
  const parsed = typeof record?.updatedAt === "string" ? Date.parse(record.updatedAt) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function upsertMapRow(params: {
  namespace: string;
  workspaceDir: string;
  key: string;
  value: unknown;
  createdAt: number;
  env: NodeJS.ProcessEnv;
}): void {
  const row = createDreamingWorkspaceMapStorageEntry(params.workspaceDir, params.key, params.value);
  upsertPluginStateMigrationEntry({
    pluginId: MEMORY_CORE_PLUGIN_ID,
    namespace: params.namespace,
    key: row.key,
    value: row.value,
    createdAt: params.createdAt,
    env: params.env,
  });
}

function upsertValueRow(params: {
  workspaceDir: string;
  key: string;
  value: unknown;
  createdAt: number;
  env: NodeJS.ProcessEnv;
}): void {
  const row = createDreamingWorkspaceValueStorageEntry(
    params.workspaceDir,
    params.key,
    params.value,
  );
  upsertPluginStateMigrationEntry({
    pluginId: MEMORY_CORE_PLUGIN_ID,
    namespace: MEMORY_CORE_SHORT_TERM_META_NAMESPACE,
    key: row.key,
    value: row.value,
    createdAt: params.createdAt,
    env: params.env,
  });
}

function upsertSessionCorpusLine(params: {
  workspaceDir: string;
  relativePath: string;
  lineNumber: number;
  text: string;
  createdAt: number;
  env: NodeJS.ProcessEnv;
}): void {
  const row = createDreamingSessionCorpusLineStorageEntry({
    workspaceDir: params.workspaceDir,
    relativePath: params.relativePath,
    lineNumber: params.lineNumber,
    text: params.text,
  });
  upsertPluginStateMigrationEntry({
    pluginId: MEMORY_CORE_PLUGIN_ID,
    namespace: MEMORY_CORE_SESSION_CORPUS_LINES_NAMESPACE,
    key: row.key,
    value: row.value,
    createdAt: params.createdAt,
    env: params.env,
  });
}

function configuredDreamingWorkspaces(cfg: OpenClawConfig): string[] {
  return resolveMemoryDreamingWorkspaces(cfg).map((entry) => entry.workspaceDir);
}

export async function legacyMemoryCoreDreamingStateFilesExist(params: {
  cfg: OpenClawConfig;
}): Promise<boolean> {
  for (const workspaceDir of configuredDreamingWorkspaces(params.cfg)) {
    for (const relativePath of Object.values(DREAMING_STATE_RELATIVE_PATHS)) {
      if (await fileExists(path.join(workspaceDir, relativePath))) {
        return true;
      }
    }
  }
  return false;
}

export async function importLegacyMemoryCoreDreamingStateFilesToSqlite(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): Promise<MigrationResult> {
  const result: MigrationResult = {
    workspaces: 0,
    files: 0,
    rows: 0,
    removedLocks: 0,
    warnings: [],
  };
  for (const workspaceDir of configuredDreamingWorkspaces(params.cfg)) {
    let touchedWorkspace = false;

    const dailyPath = path.join(workspaceDir, DREAMING_STATE_RELATIVE_PATHS.dailyIngestion);
    const daily = asRecord(await readJsonIfExists(dailyPath));
    const dailyFiles = asRecord(daily?.files);
    if (dailyFiles) {
      const createdAt = createdAtFromRecord(daily);
      for (const [key, value] of Object.entries(dailyFiles)) {
        upsertMapRow({
          namespace: MEMORY_CORE_DAILY_INGESTION_STATE_NAMESPACE,
          workspaceDir,
          key,
          value,
          createdAt,
          env: params.env,
        });
        result.rows += 1;
      }
      await fs.rm(dailyPath, { force: true });
      result.files += 1;
      touchedWorkspace = true;
    }

    const sessionPath = path.join(workspaceDir, DREAMING_STATE_RELATIVE_PATHS.sessionIngestion);
    const session = asRecord(await readJsonIfExists(sessionPath));
    if (session) {
      const createdAt = createdAtFromRecord(session);
      for (const [key, value] of Object.entries(asRecord(session.files) ?? {})) {
        upsertMapRow({
          namespace: MEMORY_CORE_SESSION_INGESTION_FILES_NAMESPACE,
          workspaceDir,
          key,
          value,
          createdAt,
          env: params.env,
        });
        result.rows += 1;
      }
      for (const [key, value] of Object.entries(asRecord(session.seenMessages) ?? {})) {
        upsertMapRow({
          namespace: MEMORY_CORE_SESSION_INGESTION_MESSAGES_NAMESPACE,
          workspaceDir,
          key,
          value,
          createdAt,
          env: params.env,
        });
        result.rows += 1;
      }
      await fs.rm(sessionPath, { force: true });
      result.files += 1;
      touchedWorkspace = true;
    }

    const recallPath = path.join(workspaceDir, DREAMING_STATE_RELATIVE_PATHS.shortTermRecall);
    const recall = asRecord(await readJsonIfExists(recallPath));
    if (recall) {
      const createdAt = createdAtFromRecord(recall);
      for (const [key, value] of Object.entries(asRecord(recall.entries) ?? {})) {
        upsertMapRow({
          namespace: MEMORY_CORE_SHORT_TERM_RECALL_NAMESPACE,
          workspaceDir,
          key,
          value,
          createdAt,
          env: params.env,
        });
        result.rows += 1;
      }
      if (typeof recall.updatedAt === "string") {
        upsertValueRow({
          workspaceDir,
          key: "recall",
          value: { updatedAt: recall.updatedAt },
          createdAt,
          env: params.env,
        });
        result.rows += 1;
      }
      await fs.rm(recallPath, { force: true });
      result.files += 1;
      touchedWorkspace = true;
    }

    const phasePath = path.join(workspaceDir, DREAMING_STATE_RELATIVE_PATHS.phaseSignals);
    const phase = asRecord(await readJsonIfExists(phasePath));
    if (phase) {
      const createdAt = createdAtFromRecord(phase);
      for (const [key, value] of Object.entries(asRecord(phase.entries) ?? {})) {
        upsertMapRow({
          namespace: MEMORY_CORE_SHORT_TERM_PHASE_SIGNAL_NAMESPACE,
          workspaceDir,
          key,
          value,
          createdAt,
          env: params.env,
        });
        result.rows += 1;
      }
      if (typeof phase.updatedAt === "string") {
        upsertValueRow({
          workspaceDir,
          key: "phase-signals",
          value: { updatedAt: phase.updatedAt },
          createdAt,
          env: params.env,
        });
        result.rows += 1;
      }
      await fs.rm(phasePath, { force: true });
      result.files += 1;
      touchedWorkspace = true;
    }

    const eventsPath = resolveMemoryHostEventLogPath(workspaceDir);
    if (await fileExists(eventsPath)) {
      const imported = await importLegacyMemoryHostEventLogToSqlite({
        workspaceDir,
        eventLogPath: eventsPath,
        env: params.env,
      });
      result.rows += imported.imported;
      result.warnings.push(...imported.warnings);
      if (imported.warnings.length === 0) {
        result.files += 1;
      }
      touchedWorkspace = true;
    }

    const sessionCorpusDir = path.join(
      workspaceDir,
      DREAMING_STATE_RELATIVE_PATHS.sessionCorpusDir,
    );
    if (await dirExists(sessionCorpusDir)) {
      const entries = await fs.readdir(sessionCorpusDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || (!entry.name.endsWith(".txt") && !entry.name.endsWith(".md"))) {
          continue;
        }
        const sourcePath = path.join(sessionCorpusDir, entry.name);
        const relativePath = path.posix.join("memory", ".dreams", "session-corpus", entry.name);
        const raw = await fs.readFile(sourcePath, "utf8");
        const lines =
          raw.length === 0 ? [] : raw.replace(/\r\n/g, "\n").replace(/\n$/u, "").split("\n");
        const createdAt = Date.now();
        for (const [index, line] of lines.entries()) {
          upsertSessionCorpusLine({
            workspaceDir,
            relativePath,
            lineNumber: index + 1,
            text: line,
            createdAt,
            env: params.env,
          });
          result.rows += 1;
        }
        await fs.rm(sourcePath, { force: true });
        result.files += 1;
        touchedWorkspace = true;
      }
      await fs.rmdir(sessionCorpusDir).catch(() => {});
    }

    const lockPath = path.join(workspaceDir, DREAMING_STATE_RELATIVE_PATHS.shortTermLock);
    if (await fileExists(lockPath)) {
      await fs.rm(lockPath, { force: true });
      result.removedLocks += 1;
      touchedWorkspace = true;
    }

    if (touchedWorkspace) {
      result.workspaces += 1;
    }
  }
  return result;
}
