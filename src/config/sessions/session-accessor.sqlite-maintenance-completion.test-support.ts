import { expectDefined } from "@openclaw/normalization-core";
import { onTestFinished, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import type {
  SessionEntryMaintenancePlan,
  SessionEntryMaintenanceResult,
} from "./session-accessor.sqlite-lifecycle-types.js";
import * as maintenance from "./session-accessor.sqlite-maintenance.js";
import * as reclamationRun from "./session-accessor.sqlite-reclamation-run.js";

/** Join archive publication for changes, or the settled verified deadline for empty plans. */
export function observeSessionMaintenanceCompletion(
  databasePath: string,
  options: {
    accept?: (result: SessionEntryMaintenancePlan | SessionEntryMaintenanceResult) => boolean;
    automatic?: boolean;
  } = {},
) {
  const accept = options.accept ?? (() => true);
  const finalize = vi.isMockFunction(
    maintenance.finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort,
  )
    ? expectDefined(
        vi
          .mocked(maintenance.finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort)
          .getMockImplementation(),
        "Session maintenance finalization observer",
      )
    : maintenance.finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort;
  const completed = createDeferredCore<
    SessionEntryMaintenancePlan | SessionEntryMaintenanceResult
  >();
  const reclaim = vi.isMockFunction(reclamationRun.runSqliteSessionReclamation)
    ? expectDefined(
        vi.mocked(reclamationRun.runSqliteSessionReclamation).getMockImplementation(),
        "Session reclamation observer",
      )
    : reclamationRun.runSqliteSessionReclamation;
  let emptyPlan: SessionEntryMaintenancePlan | undefined;
  const ageObserver = vi
    .spyOn(reclamationRun, "runSqliteSessionReclamation")
    .mockImplementation(async (params) => {
      let consumed: SessionEntryMaintenancePlan | undefined;
      const consume = params.consumeReadOnlyMaintenancePlan;
      const result = await reclaim({
        ...params,
        ...(consume
          ? {
              consumeReadOnlyMaintenancePlan(read, assertCurrent) {
                consume(read, assertCurrent);
                consumed = read.value;
              },
            }
          : {}),
      });
      if (params.plan.databaseOptions.path !== databasePath) {
        return result;
      }
      if (result.kind === "maintenance-plan" && consumed && accept(consumed)) {
        completed.resolve(consumed);
      }
      if (result.kind === "maintenance-plan") {
        const plan = result.value;
        emptyPlan =
          plan.archived === 0 &&
          plan.entryRemovals.length === 0 &&
          plan.stateDeletePlans.length === 0
            ? plan
            : undefined;
      } else if (
        params.plan.kind === "maintenance-age" &&
        result.kind === "maintenance-age" &&
        emptyPlan &&
        accept(emptyPlan)
      ) {
        completed.resolve(emptyPlan);
      }
      return result;
    });
  const observer = vi
    .spyOn(maintenance, "finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort")
    .mockImplementation((scope, ...args) => {
      const result = finalize(scope, ...args);
      if (scope.path === databasePath && (!options.automatic || args[1]?.isCurrent)) {
        void result.then((value) => {
          if (accept(value)) {
            completed.resolve(value);
          }
        }, completed.reject);
      }
      return result;
    });
  onTestFinished(() => {
    observer.mockRestore();
    ageObserver.mockRestore();
  });
  return completed.promise;
}
