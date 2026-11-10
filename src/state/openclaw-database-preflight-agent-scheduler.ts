import { realpathSync } from "node:fs";
import { availableParallelism } from "node:os";
import {
  isSqliteInspectionDeadlineOwnedByCaller,
  resolveSqliteInspectionSignal,
  withSqliteReadOnlyWorkerScope,
} from "../infra/sqlite-readonly-worker.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { AgentDatabaseAdmissionRefusal } from "./agent-database-admission.js";
import { AGENT_DATABASE_PREFLIGHT_CONCURRENCY } from "./openclaw-agent-db-contract.js";
import { createAgentSchemaInspectionWorker } from "./openclaw-agent-schema-inspection-worker.js";
import type {
  AgentDatabasePreflightStats,
  OpenClawDatabaseSchemaPreflight,
} from "./openclaw-database-preflight.types.js";

// Slow disks keep their full inspection budget without holding the Gateway listener.
const AGENT_DATABASE_STARTUP_WAIT_MS = 5_000;

/** First real path and agent id wins. A missing path stays on the normal inspection path. */
export function openClawDatabasePreflightClaimKey(target: {
  path: string;
  agentId?: string;
}): string | undefined {
  try {
    return `${realpathSync.native(target.path)}\0${target.agentId ?? ""}`;
  } catch {
    return undefined;
  }
}
// Claim misses and clean-close reads settle in a few microtasks. A reader child does not.
const FAST_INSPECTION_TURNS = 8;

export async function preflightAgentDatabasesBounded<T>(
  targets: readonly T[],
  inspect: (
    target: T,
    inspection: OpenClawDatabaseSchemaPreflight,
    claimAgentTarget: (realPath: string, agentId: string | undefined) => boolean,
    inspectSchema: ReturnType<typeof createAgentSchemaInspectionWorker>["inspect"],
  ) => Promise<"defer" | void>,
  result: OpenClawDatabaseSchemaPreflight,
  signal?: AbortSignal,
  startup?: {
    signal: AbortSignal;
    canDefer: (target: T) => boolean;
    /** Clean-closed stores admit in-process; unsealed ones need a cold reader process. */
    cleanClose?: (target: T) => boolean;
    /** Real path plus agent id. The first copy keeps its list position. */
    claimKey?: (target: T) => string | undefined;
    track: (work: Promise<unknown>) => void;
    defer: (
      inspections: { target: T; result: Promise<OpenClawDatabaseSchemaPreflight> }[],
      reason: string,
    ) => AgentDatabaseAdmissionRefusal[];
  },
  takePrestartedReader?: () => ReturnType<typeof createAgentSchemaInspectionWorker> | undefined,
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

  // Inspect cheap clean-closed stores first so slow unsealed stores at the head of the list
  // cannot hold both slots past the startup wait and defer the whole fleet. The partition is
  // stable, so targets sharing a path keep their claim order and results keep list order.
  // Later copies of the same real path and agent keep the first copy's position and an empty
  // result, the same outcome as a failed claim, so the startup timer cannot defer them.
  const sealed = startup?.cleanClose;
  let inspectionOrder = targets.map((_, index) => index);
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
  const dispatched = new Set<number>();
  let startupBudgetElapsed = false;
  const slotRelease = targets.map(() => createDeferredCore());
  if (startup?.claimKey) {
    const claimKey = startup.claimKey;
    const firstByKey = new Map<string, number>();
    const duplicates = new Set<number>();
    for (const index of inspectionOrder) {
      const key = claimKey(targets[index]!);
      if (!key) {
        continue;
      }
      const first = firstByKey.get(key);
      if (first === undefined) {
        firstByKey.set(key, index);
      } else {
        duplicates.add(index);
      }
    }
    for (const index of duplicates) {
      const empty: OpenClawDatabaseSchemaPreflight = { incompatible: [], indeterminate: [] };
      inspections[index] = empty;
      completions[index]!.resolve(empty);
    }
    if (duplicates.size > 0) {
      inspectionOrder = inspectionOrder.filter((index) => !duplicates.has(index));
    }
  }
  if (sealed) {
    const isSealed = targets.map((target) => sealed(target));
    inspectionOrder.sort((left, right) => Number(isSealed[right]) - Number(isSealed[left]));
  }
  const concurrency = Math.min(
    AGENT_DATABASE_PREFLIGHT_CONCURRENCY,
    availableParallelism(),
    targets.length,
  );
  let deferredRefusals: AgentDatabaseAdmissionRefusal[] = [];
  let foregroundSettled = false;
  const inspectionSignal = startup
    ? signal
      ? AbortSignal.any([startup.signal, signal])
      : startup.signal
    : resolveSqliteInspectionSignal(signal);
  const deadlineOwnedByCaller = startup !== undefined || isSqliteInspectionDeadlineOwnedByCaller();
  const settleForeground = () => {
    if (
      !startup ||
      foregroundSettled ||
      deferred.size === 0 ||
      deferredRefusals.length > 0 ||
      failures.size > 0
    ) {
      return;
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
        "Inspection and writable admission continue after the Gateway listener binds.",
      );
      foregroundSettled = true;
      foreground.resolve();
    } catch (error) {
      foreground.reject(error);
    }
  };

  const recordInspection = (
    index: number,
    inspection: OpenClawDatabaseSchemaPreflight,
    disposition: "defer" | void,
  ) => {
    if (inspections[index] !== undefined) {
      return;
    }
    inspections[index] = inspection;
    completions[index]!.resolve(inspection);
    if (disposition === "defer" && startup?.canDefer(targets[index]!)) {
      deferred.add(index);
    }
  };
  const watchInspection = (work: Promise<"defer" | void>) =>
    work.then(
      (disposition) => ({ ok: true as const, disposition }),
      (error: unknown) => ({ ok: false as const, error }),
    );

  const worker = async () => {
    const backgrounds: Promise<void>[] = [];
    await using reader = takePrestartedReader?.() ?? createAgentSchemaInspectionWorker();
    readers.push(reader);
    const finishInBackground = (
      index: number,
      inspection: OpenClawDatabaseSchemaPreflight,
      watched: ReturnType<typeof watchInspection>,
    ) => {
      backgrounds.push(
        watched.then((value) => {
          if (!value.ok) {
            if (inspections[index] === undefined) {
              failures.set(index, value.error);
              completions[index]!.reject(value.error);
            }
            return;
          }
          recordInspection(index, inspection, value.disposition);
        }),
      );
    };
    try {
      while (true) {
        if (inspectionSignal?.aborted || failures.size > 0) {
          return;
        }

        if (nextInspectionIndex >= inspectionOrder.length) {
          settleForeground();
          return;
        }
        const index = inspectionOrder[nextInspectionIndex]!;
        nextInspectionIndex += 1;

        const target = targets[index];
        if (target === undefined) {
          continue;
        }
        dispatched.add(index);

        const inspection: OpenClawDatabaseSchemaPreflight = {
          incompatible: [],
          indeterminate: [],
        };
        const runInspection = () =>
          inspect(target, inspection, claimAgentTarget, (input, requestSignal, snapshot) =>
            reader.inspect(input, inspectionSignal ?? requestSignal, snapshot),
          );
        try {
          if (!startup) {
            recordInspection(index, inspection, await runInspection());
            continue;
          }
          const watched = watchInspection(runInspection());
          if (!startupBudgetElapsed) {
            const winner = await Promise.race([
              watched.then((value) => ({ kind: "done" as const, value })),
              slotRelease[index]!.promise.then(() => ({ kind: "released" as const })),
            ]);
            if (winner.kind === "released") {
              // The slow reader keeps running. The slot moves on so sealed stores behind it
              // can admit before the listener binds.
              finishInBackground(index, inspection, watched);
              continue;
            }
            if (!winner.value.ok) {
              throw winner.value.error;
            }
            recordInspection(index, inspection, winner.value.disposition);
            continue;
          }
          let quick: Awaited<typeof watched> | undefined = await Promise.race([
            watched,
            (async (): Promise<undefined> => {
              for (let turn = 0; turn < FAST_INSPECTION_TURNS; turn += 1) {
                await Promise.resolve();
              }
              return undefined;
            })(),
          ]);
          if (quick === undefined) {
            if (startup.canDefer(target)) {
              deferred.add(index);
              finishInBackground(index, inspection, watched);
              continue;
            }
            quick = await watched;
          }
          if (!quick.ok) {
            throw quick.error;
          }
          recordInspection(index, inspection, quick.disposition);
        } catch (error) {
          failures.set(index, error);
          if (inspections[index] === undefined) {
            completions[index]!.reject(error);
          }
          return;
        } finally {
          settleForeground();
        }
      }
    } finally {
      await Promise.allSettled(backgrounds);
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
  const timer =
    startup &&
    setTimeout(() => {
      if (failures.size > 0 || inspectionSignal?.aborted) {
        return;
      }
      startupBudgetElapsed = true;
      const strictInFlight = targets.some(
        (target, index) =>
          dispatched.has(index) &&
          inspections[index] === undefined &&
          !deferred.has(index) &&
          !startup.canDefer(target),
      );
      if (strictInFlight) {
        // A store that cannot leave the foreground still holds its slot. Defer the
        // other unfinished targets. Duplicate copies already have an empty result.
        targets.forEach((target, index) => {
          if (inspections[index] === undefined && startup.canDefer(target)) {
            deferred.add(index);
          }
        });
        settleForeground();
        return;
      }
      targets.forEach((target, index) => {
        if (inspections[index] === undefined && dispatched.has(index) && startup.canDefer(target)) {
          deferred.add(index);
          slotRelease[index]!.resolve();
        }
      });
    }, AGENT_DATABASE_STARTUP_WAIT_MS);
  timer?.unref();
  try {
    await (startup ? Promise.race([completed, foreground.promise]) : completed);
  } finally {
    clearTimeout(timer);
  }

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
