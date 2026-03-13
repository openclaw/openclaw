import fs from "node:fs/promises";
import path from "node:path";

export type TemporalDecayConfig = {
  enabled: boolean;
  halfLifeDays: number;
};

export const DEFAULT_TEMPORAL_DECAY_CONFIG: TemporalDecayConfig = {
  enabled: false,
  halfLifeDays: 30,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Date extraction patterns for memory file paths, ordered from most specific to least.
 *
 * Supported formats:
 *   memory/YYYY-MM-DD.md           (exact daily log)
 *   memory/YYYY-MM-DD-<suffix>.md  (daily log with descriptive suffix)
 *   memory/YYYY-MM-DD/<name>.md    (date-based subdirectory)
 *   memory/YYYY/MM/DD.md           (nested year/month/day)
 *   memory/YYYY/MM/DD-<suffix>.md  (nested with suffix)
 *   memory/YYYY-MM/DD.md           (year-month dir, day file)
 *   memory/YYYY-MM/DD-<suffix>.md  (year-month dir, day file with suffix)
 */
const DATED_MEMORY_PATH_PATTERNS: RegExp[] = [
  // memory/YYYY-MM-DD.md (original exact match)
  /(?:^|\/)memory\/(\d{4})-(\d{2})-(\d{2})\.md$/,
  // memory/YYYY-MM-DD-<suffix>.md (e.g. memory/2024-03-15-standup.md)
  /(?:^|\/)memory\/(\d{4})-(\d{2})-(\d{2})-[^/]+\.md$/,
  // memory/YYYY-MM-DD/<anything>.md (date subdirectory)
  /(?:^|\/)memory\/(\d{4})-(\d{2})-(\d{2})\/[^/]+\.md$/,
  // memory/YYYY/MM/DD.md or memory/YYYY/MM/DD-<suffix>.md
  /(?:^|\/)memory\/(\d{4})\/(\d{2})\/(\d{2})(?:-[^/]+)?\.md$/,
  // memory/YYYY-MM/DD.md or memory/YYYY-MM/DD-<suffix>.md
  /(?:^|\/)memory\/(\d{4})-(\d{2})\/(\d{2})(?:-[^/]+)?\.md$/,
];

export function toDecayLambda(halfLifeDays: number): number {
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) {
    return 0;
  }
  return Math.LN2 / halfLifeDays;
}

export function calculateTemporalDecayMultiplier(params: {
  ageInDays: number;
  halfLifeDays: number;
}): number {
  const lambda = toDecayLambda(params.halfLifeDays);
  const clampedAge = Math.max(0, params.ageInDays);
  if (lambda <= 0 || !Number.isFinite(clampedAge)) {
    return 1;
  }
  return Math.exp(-lambda * clampedAge);
}

export function applyTemporalDecayToScore(params: {
  score: number;
  ageInDays: number;
  halfLifeDays: number;
}): number {
  return params.score * calculateTemporalDecayMultiplier(params);
}

/**
 * Returns "matched" if a dated pattern matched and the date is valid,
 * "looks-dated" if a pattern matched but the date is invalid (e.g. 2025-13-40),
 * or null if no pattern matched at all.
 */
function parseMemoryDateFromPath(
  filePath: string,
): { status: "matched"; date: Date } | { status: "looks-dated" } | null {
  const normalized = filePath.replaceAll("\\", "/").replace(/^\.\//, "");

  for (const pattern of DATED_MEMORY_PATH_PATTERNS) {
    const match = pattern.exec(normalized);
    if (!match) {
      continue;
    }

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
      // Pattern matched but components are not integers — treat as "looks dated"
      return { status: "looks-dated" };
    }

    const timestamp = Date.UTC(year, month - 1, day);
    const parsed = new Date(timestamp);
    if (
      parsed.getUTCFullYear() !== year ||
      parsed.getUTCMonth() !== month - 1 ||
      parsed.getUTCDate() !== day
    ) {
      // Pattern matched but date is invalid (e.g. month=13, day=40)
      // Return "looks-dated" so caller can fall back to fs.stat mtime
      return { status: "looks-dated" };
    }

    return { status: "matched", date: parsed };
  }

  return null;
}

function isEvergreenMemoryPath(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/").replace(/^\.\//, "");
  if (normalized === "MEMORY.md" || normalized === "memory.md") {
    return true;
  }
  if (!normalized.startsWith("memory/")) {
    return false;
  }
  // A file is evergreen only if no dated pattern matched at all.
  // Files with invalid dates (looks-dated) are NOT evergreen — they should
  // fall back to fs.stat mtime decay instead of being treated as timeless.
  return parseMemoryDateFromPath(normalized) === null;
}

async function extractTimestamp(params: {
  filePath: string;
  source?: string;
  workspaceDir?: string;
}): Promise<Date | null> {
  const parseResult = parseMemoryDateFromPath(params.filePath);

  // Valid dated path — use the date from the filename
  if (parseResult?.status === "matched") {
    return parseResult.date;
  }

  // Memory root/topic files are evergreen knowledge and should not decay.
  if (params.source === "memory" && isEvergreenMemoryPath(params.filePath)) {
    return null;
  }

  // For "looks-dated" files (invalid date in filename) and non-dated files,
  // fall back to fs.stat mtime so they still get some decay rather than none.
  if (!params.workspaceDir) {
    return null;
  }

  const absolutePath = path.isAbsolute(params.filePath)
    ? params.filePath
    : path.resolve(params.workspaceDir, params.filePath);

  try {
    const stat = await fs.stat(absolutePath);
    if (!Number.isFinite(stat.mtimeMs)) {
      return null;
    }
    return new Date(stat.mtimeMs);
  } catch {
    return null;
  }
}

function ageInDaysFromTimestamp(timestamp: Date, nowMs: number): number {
  const ageMs = Math.max(0, nowMs - timestamp.getTime());
  return ageMs / DAY_MS;
}

export async function applyTemporalDecayToHybridResults<
  T extends { path: string; score: number; source: string },
>(params: {
  results: T[];
  temporalDecay?: Partial<TemporalDecayConfig>;
  workspaceDir?: string;
  nowMs?: number;
}): Promise<T[]> {
  const config = { ...DEFAULT_TEMPORAL_DECAY_CONFIG, ...params.temporalDecay };
  if (!config.enabled || config.halfLifeDays <= 0) {
    return [...params.results];
  }

  const nowMs = params.nowMs ?? Date.now();
  const timestampPromiseCache = new Map<string, Promise<Date | null>>();

  return Promise.all(
    params.results.map(async (entry) => {
      const cacheKey = `${entry.source}:${entry.path}`;
      let timestampPromise = timestampPromiseCache.get(cacheKey);
      if (!timestampPromise) {
        timestampPromise = extractTimestamp({
          filePath: entry.path,
          source: entry.source,
          workspaceDir: params.workspaceDir,
        });
        timestampPromiseCache.set(cacheKey, timestampPromise);
      }

      const timestamp = await timestampPromise;
      if (!timestamp) {
        return entry;
      }

      const decayedScore = applyTemporalDecayToScore({
        score: entry.score,
        ageInDays: ageInDaysFromTimestamp(timestamp, nowMs),
        halfLifeDays: config.halfLifeDays,
      });

      return {
        ...entry,
        score: decayedScore,
      };
    }),
  );
}
