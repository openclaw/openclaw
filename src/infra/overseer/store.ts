import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../json-file.js";
import { acquireOverseerStoreLock } from "./store.lock.js";
import type {
  OverseerAssignmentRecord,
  OverseerCrystallizationRecord,
  OverseerDispatchHistoryEntry,
  OverseerEvent,
  OverseerGoalRecord,
  OverseerStore,
} from "./store.types.js";

const STORE_VERSION = 1 as const;
const DEFAULT_DIR_NAME = "overseer";
const DEFAULT_FILE_NAME = "store.json";

const MAX_INSTRUCTION_CHARS = 16_384;
const MAX_SUMMARY_CHARS = 8_192;
const MAX_NOTE_CHARS = 4_096;
const MAX_ARRAY_ITEMS = 200;

function expandUserDir(input: string): string {
  if (!input) return input;
  if (input.startsWith("~")) {
    return path.resolve(input.replace(/^~(?=$|[\\/])/, os.homedir()));
  }
  return path.resolve(input);
}

export function resolveOverseerDir(cfg = loadConfig()): string {
  const envOverride = process.env.CLAWDBOT_OVERSEER_DIR?.trim();
  if (envOverride) return expandUserDir(envOverride);
  const cfgOverride = cfg.overseer?.storage?.dir?.trim();
  if (cfgOverride) return expandUserDir(cfgOverride);
  return path.join(resolveStateDir(), DEFAULT_DIR_NAME);
}

export function resolveOverseerStorePath(cfg = loadConfig()): string {
  return path.join(resolveOverseerDir(cfg), DEFAULT_FILE_NAME);
}

export function createEmptyOverseerStore(now = Date.now()): OverseerStore {
  return {
    version: STORE_VERSION,
    goals: {},
    assignments: {},
    crystallizations: {},
    dispatchIndex: {},
    events: [],
    updatedAt: now,
  };
}

function archiveCorruptStore(pathname: string): string | null {
  try {
    const ts = new Date().toISOString().replaceAll(":", "-");
    const archived = `${pathname}.corrupt-${ts}`;
    fs.renameSync(pathname, archived);
    return archived;
  } catch {
    return null;
  }
}

function capArray<T>(input: T[] | undefined, maxItems = MAX_ARRAY_ITEMS): T[] | undefined {
  if (!Array.isArray(input)) return input;
  if (input.length <= maxItems) return input;
  return input.slice(0, maxItems);
}

function capString(input: string | undefined, maxChars: number): string | undefined {
  if (typeof input !== "string") return input;
  if (input.length <= maxChars) return input;
  return input.slice(0, maxChars);
}

function sanitizeDispatchHistory(
  entry: OverseerDispatchHistoryEntry,
): OverseerDispatchHistoryEntry {
  return {
    ...entry,
    notes: capString(entry.notes, MAX_NOTE_CHARS),
  };
}

function sanitizeAssignment(entry: OverseerAssignmentRecord): OverseerAssignmentRecord {
  const dispatchHistory = entry.dispatchHistory?.map(sanitizeDispatchHistory) ?? [];
  return {
    ...entry,
    lastInstructionText: capString(entry.lastInstructionText, MAX_INSTRUCTION_CHARS),
    dispatchHistory,
  };
}

function sanitizeGoal(entry: OverseerGoalRecord): OverseerGoalRecord {
  return {
    ...entry,
    successCriteria: capArray(entry.successCriteria) ?? [],
    nonGoals: capArray(entry.nonGoals) ?? [],
    constraints: capArray(entry.constraints),
    assumptions: capArray(entry.assumptions),
    risks: capArray(entry.risks),
    planRevisionHistory: capArray(entry.planRevisionHistory),
  };
}

function sanitizeCrystallization(
  entry: OverseerCrystallizationRecord,
): OverseerCrystallizationRecord {
  return {
    ...entry,
    summary: capString(entry.summary, MAX_SUMMARY_CHARS),
    currentState: capString(entry.currentState, MAX_SUMMARY_CHARS),
    decisions: capArray(entry.decisions),
    nextActions: capArray(entry.nextActions),
    openQuestions: capArray(entry.openQuestions),
    knownBlockers: capArray(entry.knownBlockers),
    evidence: entry.evidence
      ? {
          ...entry.evidence,
          filesTouched: capArray(entry.evidence.filesTouched),
          commandsRun: capArray(entry.evidence.commandsRun),
          testsRun: capArray(entry.evidence.testsRun),
          commits: capArray(entry.evidence.commits),
          prs: capArray(entry.evidence.prs),
          issues: capArray(entry.evidence.issues),
          externalRefs: capArray(entry.evidence.externalRefs),
        }
      : undefined,
  };
}

function sanitizeEvents(events: OverseerEvent[]): OverseerEvent[] {
  if (!Array.isArray(events)) return [];
  return events.filter(Boolean);
}

function sanitizeStore(store: OverseerStore): OverseerStore {
  const goals: Record<string, OverseerGoalRecord> = {};
  for (const [id, entry] of Object.entries(store.goals ?? {})) {
    if (!entry) continue;
    goals[id] = sanitizeGoal(entry);
  }
  const assignments: Record<string, OverseerAssignmentRecord> = {};
  for (const [id, entry] of Object.entries(store.assignments ?? {})) {
    if (!entry) continue;
    assignments[id] = sanitizeAssignment(entry);
  }
  const crystallizations: Record<string, OverseerCrystallizationRecord> = {};
  for (const [id, entry] of Object.entries(store.crystallizations ?? {})) {
    if (!entry) continue;
    crystallizations[id] = sanitizeCrystallization(entry);
  }
  return {
    ...store,
    version: STORE_VERSION,
    goals,
    assignments,
    crystallizations,
    events: sanitizeEvents(store.events ?? []),
    updatedAt: store.updatedAt ?? Date.now(),
  };
}

function coerceStore(raw: unknown): OverseerStore | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Partial<OverseerStore>;
  if (rec.version !== 1) return null;
  return sanitizeStore({
    version: 1,
    goals: rec.goals ?? {},
    assignments: rec.assignments ?? {},
    crystallizations: rec.crystallizations ?? {},
    dispatchIndex: rec.dispatchIndex ?? {},
    events: rec.events ?? [],
    updatedAt: rec.updatedAt,
    safeMode: rec.safeMode,
  });
}

export function loadOverseerStoreFromDisk(cfg = loadConfig()): OverseerStore {
  const pathname = resolveOverseerStorePath(cfg);
  const exists = fs.existsSync(pathname);
  const raw = loadJsonFile(pathname);
  const parsed = coerceStore(raw);
  if (parsed) return parsed;
  if (!exists) return createEmptyOverseerStore();
  const archived = archiveCorruptStore(pathname);
  const store = createEmptyOverseerStore();
  store.safeMode = { reason: "store-corrupt", at: Date.now() };
  store.events.push({
    ts: Date.now(),
    type: "overseer.store.corrupt",
    data: archived ? { archivedPath: archived } : { archivedPath: null },
  });
  return store;
}

export function saveOverseerStoreToDisk(store: OverseerStore, cfg = loadConfig()) {
  const pathname = resolveOverseerStorePath(cfg);
  const sanitized = sanitizeStore(store);
  saveJsonFile(pathname, sanitized);
}

export async function updateOverseerStore<T>(
  fn: (store: OverseerStore) => Promise<{ store: OverseerStore; result: T }>,
  cfg = loadConfig(),
): Promise<T> {
  const pathname = resolveOverseerStorePath(cfg);
  const lock = await acquireOverseerStoreLock({ storePath: pathname });
  try {
    const store = loadOverseerStoreFromDisk(cfg);
    const { store: nextStore, result } = await fn(store);
    saveOverseerStoreToDisk(nextStore, cfg);
    return result;
  } finally {
    await lock.release();
  }
}
