import { createHash } from "node:crypto";
import path from "node:path";
import {
  createPluginStateKeyedStore,
  type PluginStateKeyedStore,
} from "../plugin-state/plugin-state-store.js";

export const MEMORY_CORE_PLUGIN_ID = "memory-core";
const MAX_DREAMING_STATE_ROWS = 200_000;
const WORKSPACE_HASH_BYTES = 24;
export const MEMORY_CORE_DAILY_INGESTION_STATE_NAMESPACE = "dreaming.daily-ingestion";
export const MEMORY_CORE_SESSION_INGESTION_FILES_NAMESPACE = "dreaming.session-ingestion.files";
export const MEMORY_CORE_SESSION_INGESTION_MESSAGES_NAMESPACE =
  "dreaming.session-ingestion.messages";
export const MEMORY_CORE_SESSION_CORPUS_LINES_NAMESPACE = "dreaming.session-corpus.lines";
export const MEMORY_CORE_SHORT_TERM_RECALL_NAMESPACE = "dreaming.short-term-recall";
export const MEMORY_CORE_SHORT_TERM_PHASE_SIGNAL_NAMESPACE = "dreaming.phase-signals";
export const MEMORY_CORE_SHORT_TERM_META_NAMESPACE = "dreaming.short-term-meta";

type WorkspaceMapRow<T> = {
  workspaceKey: string;
  key: string;
  value: T;
};

type WorkspaceValueRow<T> = {
  workspaceKey: string;
  value: T;
};

type SessionCorpusLineRow = {
  workspaceKey: string;
  path: string;
  lineNumber: number;
  text: string;
};

const stores = new Map<string, PluginStateKeyedStore<unknown>>();

function getStore<T>(namespace: string): PluginStateKeyedStore<T> {
  const existing = stores.get(namespace);
  if (existing) {
    return existing as PluginStateKeyedStore<T>;
  }
  const store = createPluginStateKeyedStore<T>(MEMORY_CORE_PLUGIN_ID, {
    namespace,
    maxEntries: MAX_DREAMING_STATE_ROWS,
  });
  stores.set(namespace, store as PluginStateKeyedStore<unknown>);
  return store;
}

function normalizeWorkspaceKey(workspaceDir: string): string {
  const resolved = path.resolve(workspaceDir).replace(/\\/g, "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function hashValue(value: string, bytes = 32): string {
  return createHash("sha256").update(value).digest("hex").slice(0, bytes);
}

function workspacePrefix(workspaceDir: string): { prefix: string; workspaceKey: string } {
  const workspaceKey = normalizeWorkspaceKey(workspaceDir);
  return {
    prefix: hashValue(workspaceKey, WORKSPACE_HASH_BYTES),
    workspaceKey,
  };
}

function mapEntryKey(workspaceDir: string, key: string): string {
  const { prefix } = workspacePrefix(workspaceDir);
  return `${prefix}:${hashValue(key)}`;
}

function valueEntryKey(workspaceDir: string, key: string): string {
  const { prefix } = workspacePrefix(workspaceDir);
  return `${prefix}:${key}`;
}

function sessionCorpusPathKey(
  workspaceDir: string,
  relativePath: string,
  lineNumber: number,
): string {
  const { prefix } = workspacePrefix(workspaceDir);
  return `${prefix}:${hashValue(relativePath, 24)}:${lineNumber.toString().padStart(12, "0")}`;
}

function getSessionCorpusStore(
  env?: NodeJS.ProcessEnv,
): PluginStateKeyedStore<SessionCorpusLineRow> {
  return createPluginStateKeyedStore<SessionCorpusLineRow>(MEMORY_CORE_PLUGIN_ID, {
    namespace: MEMORY_CORE_SESSION_CORPUS_LINES_NAMESPACE,
    maxEntries: MAX_DREAMING_STATE_ROWS,
    ...(env ? { env } : {}),
  });
}

export function createDreamingSessionCorpusLineStorageEntry(params: {
  workspaceDir: string;
  relativePath: string;
  lineNumber: number;
  text: string;
}): { key: string; value: SessionCorpusLineRow } {
  const { workspaceKey } = workspacePrefix(params.workspaceDir);
  return {
    key: sessionCorpusPathKey(params.workspaceDir, params.relativePath, params.lineNumber),
    value: {
      workspaceKey,
      path: params.relativePath,
      lineNumber: params.lineNumber,
      text: params.text,
    },
  };
}

export function createDreamingWorkspaceMapStorageEntry<T>(
  workspaceDir: string,
  key: string,
  value: T,
): { key: string; value: WorkspaceMapRow<T> } {
  const { workspaceKey } = workspacePrefix(workspaceDir);
  return {
    key: mapEntryKey(workspaceDir, key),
    value: { workspaceKey, key, value },
  };
}

export function createDreamingWorkspaceValueStorageEntry<T>(
  workspaceDir: string,
  key: string,
  value: T,
): { key: string; value: WorkspaceValueRow<T> } {
  const { workspaceKey } = workspacePrefix(workspaceDir);
  return {
    key: valueEntryKey(workspaceDir, key),
    value: { workspaceKey, value },
  };
}

export async function readDreamingWorkspaceMap<T>(
  namespace: string,
  workspaceDir: string,
): Promise<Record<string, T>> {
  const { prefix, workspaceKey } = workspacePrefix(workspaceDir);
  const rows = await getStore<WorkspaceMapRow<T>>(namespace).entries();
  const map: Record<string, T> = {};
  for (const row of rows) {
    if (!row.key.startsWith(`${prefix}:`) || row.value.workspaceKey !== workspaceKey) {
      continue;
    }
    map[row.value.key] = row.value.value;
  }
  return map;
}

export async function writeDreamingWorkspaceMap<T>(
  namespace: string,
  workspaceDir: string,
  values: Record<string, T>,
): Promise<void> {
  const store = getStore<WorkspaceMapRow<T>>(namespace);
  const { prefix, workspaceKey } = workspacePrefix(workspaceDir);
  const nextKeys = new Set<string>();
  for (const [key, value] of Object.entries(values)) {
    const entry = createDreamingWorkspaceMapStorageEntry(workspaceDir, key, value);
    nextKeys.add(entry.key);
    await store.register(entry.key, entry.value);
  }
  const existing = await store.entries();
  await Promise.all(
    existing
      .filter((row) => row.key.startsWith(`${prefix}:`) && row.value.workspaceKey === workspaceKey)
      .filter((row) => !nextKeys.has(row.key))
      .map((row) => store.delete(row.key)),
  );
}

export async function readDreamingWorkspaceValue<T>(
  namespace: string,
  workspaceDir: string,
  key: string,
): Promise<T | undefined> {
  const { workspaceKey } = workspacePrefix(workspaceDir);
  const row = await getStore<WorkspaceValueRow<T>>(namespace).lookup(
    valueEntryKey(workspaceDir, key),
  );
  if (!row || row.workspaceKey !== workspaceKey) {
    return undefined;
  }
  return row.value;
}

export async function writeDreamingWorkspaceValue(
  namespace: string,
  workspaceDir: string,
  key: string,
  value: unknown,
): Promise<void> {
  const entry = createDreamingWorkspaceValueStorageEntry(workspaceDir, key, value);
  await getStore<WorkspaceValueRow<unknown>>(namespace).register(entry.key, entry.value);
}

export async function readDreamingSessionCorpusLines(params: {
  workspaceDir: string;
  relativePath: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string[]> {
  const { prefix, workspaceKey } = workspacePrefix(params.workspaceDir);
  return (await getSessionCorpusStore(params.env).entries())
    .filter(
      (entry) =>
        entry.key.startsWith(`${prefix}:`) &&
        entry.value.workspaceKey === workspaceKey &&
        entry.value.path === params.relativePath,
    )
    .toSorted((left, right) => {
      if (left.value.lineNumber !== right.value.lineNumber) {
        return left.value.lineNumber - right.value.lineNumber;
      }
      return left.key.localeCompare(right.key);
    })
    .map((entry) => entry.value.text);
}

export async function readDreamingSessionCorpusText(params: {
  workspaceDir: string;
  relativePath: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  const lines = await readDreamingSessionCorpusLines(params);
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

export async function writeDreamingSessionCorpusText(params: {
  workspaceDir: string;
  relativePath: string;
  text: string;
  env?: NodeJS.ProcessEnv;
}): Promise<number> {
  const store = getSessionCorpusStore(params.env);
  const { prefix, workspaceKey } = workspacePrefix(params.workspaceDir);
  const existing = await store.entries();
  await Promise.all(
    existing
      .filter(
        (entry) =>
          entry.key.startsWith(`${prefix}:`) &&
          entry.value.workspaceKey === workspaceKey &&
          entry.value.path === params.relativePath,
      )
      .map((entry) => store.delete(entry.key)),
  );
  const lines = params.text.replace(/\r\n/g, "\n").replace(/\n$/u, "").split("\n");
  const nonEmptyLines = params.text.length === 0 ? [] : lines;
  await Promise.all(
    nonEmptyLines.map((line, index) => {
      const entry = createDreamingSessionCorpusLineStorageEntry({
        workspaceDir: params.workspaceDir,
        relativePath: params.relativePath,
        lineNumber: index + 1,
        text: line,
      });
      return store.register(entry.key, entry.value);
    }),
  );
  return nonEmptyLines.length;
}

export async function appendDreamingSessionCorpusLines(params: {
  workspaceDir: string;
  relativePath: string;
  lines: string[];
  env?: NodeJS.ProcessEnv;
}): Promise<number> {
  if (params.lines.length === 0) {
    return (await readDreamingSessionCorpusLines(params)).length + 1;
  }
  const store = getSessionCorpusStore(params.env);
  const existingCount = (await readDreamingSessionCorpusLines(params)).length;
  const firstLine = existingCount + 1;
  await Promise.all(
    params.lines.map((line, index) => {
      const lineNumber = firstLine + index;
      const entry = createDreamingSessionCorpusLineStorageEntry({
        workspaceDir: params.workspaceDir,
        relativePath: params.relativePath,
        lineNumber,
        text: line,
      });
      return store.register(entry.key, entry.value);
    }),
  );
  return firstLine;
}
