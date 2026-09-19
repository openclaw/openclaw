import { availableParallelism } from "node:os";
import {
  isSqliteInspectionDeadlineOwnedByCaller,
  readSqliteInspectionBudget,
  resolveSqliteInspectionSignal,
  withSqliteReadOnlyWorkerScope,
} from "../infra/sqlite-readonly-worker.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { AgentDatabaseAdmissionRefusal } from "./agent-database-admission.js";
import { createAgentSchemaInspectionWorker } from "./openclaw-agent-schema-inspection-worker.js";
import type { OpenClawDatabaseSchemaPreflight } from "./openclaw-database-preflight.types.js";

// Snapshot preparation can be disk-heavy; overlap one additional agent
// without fanning out across every registered database.
export const AGENT_DATABASE_PREFLIGHT_CONCURRENCY = 2;

export type AgentDatabasePreflightStats = {
  schemaProcessCount: number;
  schemaInspectionCount: number;
  schemaSnapshotCount: number;
};

export async function preflightAgentDatabasesBounded<T>(
  targets: readonly T[],
  inspect: (
    target: T,
    inspection: OpenClawDatabaseSchemaPreflight,
    claimAgentTarget: (realPath: string, agentId: string | undefined) => boolean,
    inspectSchema: ReturnType<typeof createAgentSchemaInspectionWorker>["inspect"],
  ) => Promise<void>,
  result: OpenClawDatabaseSchemaPreflight,
  signal?: AbortSignal,
  startup?: {
    signal: AbortSignal;
    path: (target: T) => string;
    track: (work: Promise<unknown>) => void;
    defer: (
      inspections: { target: T; result: Promise<OpenClawDatabaseSchemaPreflight> }[],
      reason: string,
    ) => AgentDatabaseAdmissionRefusal[];
  },
): Promise<AgentDatabasePreflightStats> {
  const inspectedAgentPaths = new Set<string>();
  const inspectedAgentTargets = new Set<string>();
  const claimAgentTarget = (realPath: string, agentId: string | undefined) => {
    const inspectionKey = `${realPath}\0${agentId ?? ""}`;
    if (
      inspectedAgentTargets.has(inspectionKey) ||
      (agentId === undefined && inspectedAgentPaths.has(realPath))
    ) {
      return false;
    }
    inspectedAgentPaths.add(realPath);
    inspectedAgentTargets.add(inspectionKey);
    return true;
  };

  const inspections: Array<OpenClawDatabaseSchemaPreflight | undefined> = [];
  const failures = new Map<number, unknown>();
  let nextInspectionIndex = 0;
  const readers: ReturnType<typeof createAgentSchemaInspectionWorker>[] = [];
  const foreground = createDeferredCore();
  const completions = targets.map(() => createDeferredCore<OpenClawDatabaseSchemaPreflight>());
  for (const completion of completions) {
    void completion.promise.catch(() => {});
  }
  const deferred = new Set<number>();
  const active = new Set<number>();
  const concurrency = Math.min(
    AGENT_DATABASE_PREFLIGHT_CONCURRENCY,
    availableParallelism(),
    targets.length,
  );
  let deferredReason = "";
  let deferredRefusals: AgentDatabaseAdmissionRefusal[] = [];
  const inspectionSignal = startup
    ? signal
      ? AbortSignal.any([startup.signal, signal])
      : startup.signal
    : resolveSqliteInspectionSignal(signal);
  const deadlineOwnedByCaller = startup !== undefined || isSqliteInspectionDeadlineOwnedByCaller();
  const settleForeground = () => {
    if (!startup || deferred.size === 0 || deferredRefusals.length > 0 || failures.size > 0) {
      return;
    }
    if (active.size === concurrency && [...active].every((index) => deferred.has(index))) {
      for (let index = nextInspectionIndex; index < targets.length; index += 1) {
        deferred.add(index);
      }
    }
    if (targets.some((_, index) => inspections[index] === undefined && !deferred.has(index))) {
      return;
    }
    try {
      deferredRefusals = startup.defer(
        [...deferred].map((index) => ({
          target: targets[index]!,
          result: completions[index]!.promise,
        })),
        deferredReason,
      );
      foreground.resolve();
    } catch (error) {
      foreground.reject(error);
    }
  };

  const worker = async () => {
    await using reader = createAgentSchemaInspectionWorker();
    readers.push(reader);
    while (true) {
      if (inspectionSignal?.aborted || failures.size > 0) {
        return;
      }

      const index = nextInspectionIndex;
      if (index >= targets.length) {
        return;
      }
      nextInspectionIndex += 1;

      const target = targets[index];
      if (target === undefined) {
        continue;
      }

      const inspection: OpenClawDatabaseSchemaPreflight = {
        incompatible: [],
        indeterminate: [],
      };
      active.add(index);
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (startup && !deferred.has(index)) {
        const pathname = startup.path(target);
        const { timeoutMs, size } = readSqliteInspectionBudget("startup readiness", pathname);
        timer = setTimeout(() => {
          if (failures.size > 0 || inspectionSignal?.aborted) {
            return;
          }
          deferred.add(index);
          deferredReason ||= `The ${size} database at ${pathname} exceeded its ${timeoutMs / 1000} second startup wait; inspection continues.`;
          settleForeground();
        }, timeoutMs);
        timer.unref();
      }
      try {
        await inspect(target, inspection, claimAgentTarget, (input, requestSignal, snapshot) =>
          reader.inspect(input, inspectionSignal ?? requestSignal, snapshot),
        );
        inspections[index] = inspection;
        completions[index]!.resolve(inspection);
      } catch (error) {
        failures.set(index, error);
        completions[index]!.reject(error);
        return;
      } finally {
        clearTimeout(timer);
        active.delete(index);
        settleForeground();
      }
    }
  };

  const completed = Promise.all(
    Array.from(
      {
        length: concurrency,
      },
      () =>
        withSqliteReadOnlyWorkerScope(worker, {
          signal: inspectionSignal ?? new AbortController().signal,
          deadlineOwnedByCaller,
        }),
    ),
  ).finally(() => {
    for (let index = 0; index < targets.length; index += 1) {
      if (inspections[index] === undefined) {
        completions[index]!.reject(
          inspectionSignal?.reason ??
            failures.values().next().value ??
            new Error("Inspection cancelled"),
        );
      }
    }
  });
  startup?.track(completed);
  await (startup ? Promise.race([completed, foreground.promise]) : completed);

  // Workers are fully joined before propagating failure or cancellation so
  // every started database close and snapshot cleanup has completed.
  for (let index = 0; index < targets.length; index += 1) {
    if (failures.has(index) && (!deferred.has(index) || deferredRefusals.length === 0)) {
      throw failures.get(index);
    }
  }
  inspectionSignal?.throwIfAborted();

  // Preserve serial-result ordering even when inspections finish out of order.
  for (const [index, inspection] of inspections.entries()) {
    if (inspection === undefined || deferred.has(index)) {
      continue;
    }
    result.incompatible.push(...inspection.incompatible);
    result.indeterminate.push(...inspection.indeterminate);
    if (inspection.agentRefusals?.length) {
      (result.agentRefusals ??= []).push(...inspection.agentRefusals);
    }
    if (inspection.pendingMigrations?.length) {
      (result.pendingMigrations ??= []).push(...inspection.pendingMigrations);
    }
  }
  if (deferredRefusals.length) {
    (result.agentRefusals ??= []).push(...deferredRefusals);
  }
  return {
    schemaProcessCount: readers.reduce((count, reader) => count + reader.processCount, 0),
    schemaInspectionCount: readers.reduce((count, reader) => count + reader.inspectionCount, 0),
    schemaSnapshotCount: readers.reduce((count, reader) => count + reader.snapshotCount, 0),
  };
}
