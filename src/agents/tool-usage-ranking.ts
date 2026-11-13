import { isRecord } from "@openclaw/normalization-core/record-coerce";

/** Prompt-series facts; renderers never consult live scores or the wall clock. */
export type ToolUsageRankingSnapshot = {
  version: 1;
  at: number;
  /** Tools with usage history, in descending score order with stable-id ties. */
  orderedToolIds: string[];
  /** First-seen timestamps; only ids absent from orderedToolIds get newcomer slots. */
  newcomers?: Record<string, number>;
};

/** Decode only the versioned checkpoint contract, never scores or execution authority. */
export function readToolUsageRankingSnapshot(value: unknown): ToolUsageRankingSnapshot | undefined {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.at !== "number" ||
    !Number.isFinite(value.at) ||
    !Array.isArray(value.orderedToolIds) ||
    !value.orderedToolIds.every((id) => typeof id === "string")
  ) {
    return undefined;
  }
  const newcomers: Record<string, number> = {};
  if (isRecord(value.newcomers)) {
    for (const [id, at] of Object.entries(value.newcomers)) {
      if (typeof at === "number" && Number.isFinite(at)) {
        newcomers[id] = at;
      }
    }
  }
  return { version: 1, at: value.at, orderedToolIds: value.orderedToolIds, newcomers };
}

const NEWCOMER_WINDOW_MS = 14 * 24 * 60 * 60 * 1_000;
// One fifth bounds exploration while favoring learned usage. Charge
// characters, not tool counts: input hints vary substantially between surfaces.
const NEWCOMER_BUDGET_SHARE = 0.2;

export function hasToolUsageRanking(
  snapshot: ToolUsageRankingSnapshot | undefined,
): snapshot is ToolUsageRankingSnapshot {
  // First-seen metadata alone is not learned usage; cold starts keep baseline bytes.
  return Boolean(snapshot && snapshot.orderedToolIds.length > 0);
}

type ToolUsageRankingRow = { id: string; line: string; pinned: boolean };

/** Select membership by frozen ranking, but retain the caller's canonical row order. */
export function selectUsageRankedToolRows<T extends ToolUsageRankingRow>(
  rows: readonly T[],
  snapshot: ToolUsageRankingSnapshot,
  maxChars: number,
  overheadChars: (included: number) => number,
): T[] {
  const rank = new Map(snapshot.orderedToolIds.map((id, index) => [id, index]));
  const selected = new Set<string>();
  let lineChars = 0;
  const include = (row: T): boolean => {
    if (selected.has(row.id)) {
      return false;
    }
    const chars = row.line.length + 1;
    if (lineChars + chars + overheadChars(selected.size + 1) > maxChars) {
      return false;
    }
    selected.add(row.id);
    lineChars += chars;
    return true;
  };
  for (const row of rows) {
    if (row.pinned) {
      include(row);
    }
  }
  const byId = (left: T, right: T) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const newcomers = rows
    .filter((row) => {
      const firstSeen = snapshot.newcomers?.[row.id];
      // Tools discovered during a frozen series stay new until its next boundary.
      return (
        !row.pinned &&
        !rank.has(row.id) &&
        firstSeen !== undefined &&
        snapshot.at - firstSeen <= NEWCOMER_WINDOW_MS
      );
    })
    .toSorted(byId);
  let newcomerChars = 0;
  const newcomerBudget = Math.floor(maxChars * NEWCOMER_BUDGET_SHARE);
  for (const row of newcomers) {
    const chars = row.line.length + 1;
    if (newcomerChars + chars <= newcomerBudget && include(row)) {
      newcomerChars += chars;
    }
  }
  // Unspent reserve returns to ranked rows. Unmatched, authorized tools follow
  // them deterministically; snapshot ids can never introduce catalog entries.
  for (const row of rows.toSorted((left, right) => {
    const leftRank = rank.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = rank.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank || byId(left, right);
  })) {
    include(row);
  }
  return rows.filter((row) => selected.has(row.id));
}
