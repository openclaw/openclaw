import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type {
  SelfImprovementDailyScorecard,
  SelfImprovementDailyScorecardStoreFile,
  SelfImprovementScorecard,
} from "./types.js";

const STORE_VERSION = 1;
const STORE_DIR = "self-improvement";
const STORE_FILENAME = "scorecards.json";
const MAX_SCORECARDS = 400;

function cloneScorecard(scorecard: SelfImprovementDailyScorecard): SelfImprovementDailyScorecard {
  return structuredClone(scorecard);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function dateKeyForTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function parseScorecard(value: unknown): SelfImprovementDailyScorecard | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.dateKey !== "string") {
    return null;
  }
  return value as SelfImprovementDailyScorecard;
}

function normalizeStore(value: unknown): SelfImprovementDailyScorecardStoreFile {
  if (!isRecord(value) || !Array.isArray(value.scorecards)) {
    return { version: STORE_VERSION, scorecards: [] };
  }
  return {
    version: STORE_VERSION,
    scorecards: value.scorecards
      .map(parseScorecard)
      .filter((entry): entry is SelfImprovementDailyScorecard => Boolean(entry)),
  };
}

async function readStore(storePath: string): Promise<SelfImprovementDailyScorecardStoreFile> {
  try {
    return normalizeStore(JSON.parse(await fs.readFile(storePath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: STORE_VERSION, scorecards: [] };
    }
    throw error;
  }
}

async function writeStore(
  storePath: string,
  file: SelfImprovementDailyScorecardStoreFile,
): Promise<void> {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  const tmpPath = `${storePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, storePath);
}

export function resolveSelfImprovementScorecardStorePath(stateDir = resolveStateDir()): string {
  return path.join(stateDir, STORE_DIR, STORE_FILENAME);
}

export async function writeSelfImprovementDailyScorecardSnapshot(params: {
  scorecard: SelfImprovementScorecard;
  stateDir?: string;
  storePath?: string;
  now?: number;
}): Promise<SelfImprovementDailyScorecard> {
  const now = params.now ?? params.scorecard.generatedAt;
  const dateKey = dateKeyForTimestamp(now);
  const snapshot: SelfImprovementDailyScorecard = {
    id: `sis_${dateKey}`,
    dateKey,
    createdAt: now,
    scorecard: structuredClone(params.scorecard),
  };
  const storePath = params.storePath ?? resolveSelfImprovementScorecardStorePath(params.stateDir);
  const file = await readStore(storePath);
  const byDate = new Map(file.scorecards.map((entry) => [entry.dateKey, cloneScorecard(entry)]));
  byDate.set(dateKey, snapshot);
  const scorecards = [...byDate.values()]
    .toSorted((left, right) => right.dateKey.localeCompare(left.dateKey))
    .slice(0, MAX_SCORECARDS);
  await writeStore(storePath, { version: STORE_VERSION, scorecards });
  return cloneScorecard(snapshot);
}

export async function listSelfImprovementDailyScorecards(params?: {
  stateDir?: string;
  storePath?: string;
  days?: number;
  limit?: number;
}): Promise<SelfImprovementDailyScorecard[]> {
  const storePath = params?.storePath ?? resolveSelfImprovementScorecardStorePath(params?.stateDir);
  const file = await readStore(storePath);
  const limit = params?.limit && params.limit > 0 ? params.limit : 30;
  const minDate =
    params?.days && params.days > 0
      ? dateKeyForTimestamp(Date.now() - (params.days - 1) * 24 * 60 * 60_000)
      : null;
  return file.scorecards
    .filter((entry) => !minDate || entry.dateKey >= minDate)
    .toSorted((left, right) => right.dateKey.localeCompare(left.dateKey))
    .slice(0, limit)
    .map(cloneScorecard);
}
