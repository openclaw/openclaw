import { parseDateStringTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { SqliteJsonlReadBudgetExceededError } from "../../infra/sqlite-jsonl-budget-error.js";
import { TRAJECTORY_RUNTIME_CAPTURE_MAX_BYTES } from "../../trajectory/paths.js";
import type { TrajectoryRuntimeRetentionInput } from "../../trajectory/runtime-retention.contract.js";
import type { SqliteTrajectoryRuntimeAppend } from "../../trajectory/runtime-store.contract.js";
import type { TrajectoryEvent } from "../../trajectory/types.js";
import type {
  SessionActorMemorySideEffectsReads,
  SessionActorMemoryTrajectoryRow,
} from "./session-actor-memory-side-effects-contract.js";
import { resolveSessionActorMemoryWindow } from "./session-actor-memory-state.js";
import type { SessionActorMemoryStorageContext } from "./session-actor-memory-storage-context.js";

export function readSessionActorMemoryTrajectoryRows(
  context: SessionActorMemoryStorageContext,
  input: SessionActorMemorySideEffectsReads["session.trajectory.rows"]["input"],
): Array<{ event: TrajectoryEvent; seq: number }> {
  const rows = (context.state.trajectory.get(input.sessionId) ?? []).filter(
    (row) =>
      input.afterSeq === undefined ||
      !Number.isFinite(input.afterSeq) ||
      row.seq > Math.floor(input.afterSeq),
  );
  const tail =
    input.tailEvents !== undefined && Number.isFinite(input.tailEvents)
      ? Math.max(0, Math.floor(input.tailEvents))
      : undefined;
  if (
    tail === undefined &&
    input.maxEventCount !== undefined &&
    Number.isFinite(input.maxEventCount) &&
    input.maxEventCount >= 0 &&
    rows.length > Math.floor(input.maxEventCount)
  ) {
    throw new Error(
      `Trajectory runtime store has too many events to export (${rows.length}; limit ${Math.floor(input.maxEventCount)})`,
    );
  }
  const bytes = rows.reduce((total, row) => total + row.bytes, 0) - Number(rows.length > 0);
  if (
    tail === undefined &&
    input.maxEventBytes !== undefined &&
    Number.isFinite(input.maxEventBytes) &&
    input.maxEventBytes >= 0 &&
    bytes > Math.floor(input.maxEventBytes)
  ) {
    throw new SqliteJsonlReadBudgetExceededError(
      `Trajectory runtime store is too large to export (${bytes} bytes; limit ${Math.floor(input.maxEventBytes)})`,
    );
  }
  const maxEvents =
    input.maxEvents !== undefined && Number.isFinite(input.maxEvents)
      ? Math.max(0, Math.floor(input.maxEvents))
      : undefined;
  const limit = tail === undefined ? maxEvents : Math.min(tail, maxEvents ?? tail);
  const selected =
    limit === undefined
      ? rows
      : limit === 0
        ? []
        : tail === undefined
          ? rows.slice(0, limit)
          : rows.slice(-limit);
  return selected.map((row) => ({
    // SAFETY: Append retains the trajectory writer's serialized event bytes unchanged.
    event: JSON.parse(row.eventJson) as TrajectoryEvent,
    seq: row.seq,
  }));
}

function retainSessionActorMemoryTrajectory(
  context: SessionActorMemoryStorageContext,
  input: TrajectoryRuntimeRetentionInput & { now: number },
) {
  const runs = [];
  let totalBytes = 0;
  for (const [sessionKey, state] of context.entries()) {
    for (const [sessionId, rows] of state.trajectory) {
      const grouped = new Map<string | null, { newest: number; bytes: number }>();
      for (const row of rows) {
        const group = grouped.get(row.runId) ?? { newest: -Infinity, bytes: 0 };
        group.newest = Math.max(group.newest, row.createdAt);
        group.bytes += row.bytes;
        grouped.set(row.runId, group);
        totalBytes += row.bytes;
      }
      for (const [runId, group] of grouped) {
        runs.push({
          sessionKey,
          sessionId,
          runId,
          ...group,
          order: `${Buffer.from(sessionId).toString("hex")}/${runId === null ? "0" : `1${Buffer.from(runId).toString("hex")}`}`,
        });
      }
    }
  }
  const cutoff = input.now - 14 * 24 * 60 * 60 * 1000;
  const maxBytes = Math.max(1, Math.floor(input.maxGlobalRuntimeBytes ?? 512 * 1024 * 1024));
  runs.sort(
    (a, b) =>
      a.newest - b.newest ||
      a.sessionId.localeCompare(b.sessionId) ||
      (a.runId ?? "").localeCompare(b.runId ?? "") ||
      (a.order < b.order ? -1 : a.order > b.order ? 1 : 0),
  );
  let deleted = 0;
  for (const run of runs) {
    if (run.sessionId === input.sessionId || (run.newest >= cutoff && totalBytes <= maxBytes)) {
      continue;
    }
    const state = context.edit(run.sessionKey);
    const rows = state.trajectory.get(run.sessionId)!;
    state.trajectory.set(
      run.sessionId,
      rows.filter((row) => row.runId !== run.runId),
    );
    totalBytes -= run.bytes;
    deleted++;
  }
  return { deleted, totalBytes };
}

export function appendSessionActorMemoryTrajectory(
  context: SessionActorMemoryStorageContext,
  input: SqliteTrajectoryRuntimeAppend,
): void {
  if (!resolveSessionActorMemoryWindow(context.state, input.sessionId)) {
    throw new Error("Trajectory window does not belong to this session actor");
  }
  if (input.events.length === 0) {
    return;
  }
  const now = Date.now();
  const previous = context.state.trajectory.get(input.sessionId) ?? [];
  const nextSeq = (previous.at(-1)?.seq ?? -1) + 1;
  const added: SessionActorMemoryTrajectoryRow[] = input.events.map((event, index) => {
    const eventJson = event.line;
    return {
      seq: nextSeq + index,
      eventJson,
      bytes: Buffer.byteLength(eventJson) + 1,
      createdAt: parseDateStringTimestampMs(event.ts) ?? now,
      runId: event.runId ?? null,
    };
  });
  const rows = [...(input.discardPrevious ? [] : previous), ...added];
  const maxBytes = Math.max(
    1,
    Math.floor(input.maxRuntimeBytes ?? TRAJECTORY_RUNTIME_CAPTURE_MAX_BYTES),
  );
  let bytes = 0;
  let first = rows.length;
  while (first > 0 && bytes + rows[first - 1]!.bytes <= maxBytes) {
    bytes += rows[--first]!.bytes;
  }
  context.state.trajectory.set(input.sessionId, rows.slice(first));
  retainSessionActorMemoryTrajectory(context, { ...input, now });
}
