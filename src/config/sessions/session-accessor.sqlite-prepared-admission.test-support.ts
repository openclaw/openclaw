import { expect, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as reclamationWorker from "./session-accessor.sqlite-reclamation-worker.js";

export function holdReclamationAdmission(
  databasePath: string,
  kind: "lifecycle-projection-commit" | "maintenance-finalize",
  phase: "before-writer" | "inside-writer",
) {
  const entered = createDeferred();
  const release = createDeferred();
  const pause = async () => {
    entered.resolve();
    await release.promise;
  };
  const withWorker = reclamationWorker.withSqliteReclamationWorker;
  vi.spyOn(reclamationWorker, "withSqliteReclamationWorker").mockImplementation(
    (options, claim, run, assertCurrent, signal) =>
      withWorker(
        options,
        claim,
        async (worker) => {
          const execute = worker.run.bind(worker);
          const spy = vi.spyOn(worker, "run").mockImplementation((params) => {
            if (params.plan.databaseOptions.path !== databasePath || params.plan.kind !== kind) {
              return execute(params);
            }
            return execute({
              ...params,
              withWriteAdmission: async (performWrite, diagnostics) => {
                if (phase === "before-writer") {
                  await pause();
                }
                return params.withWriteAdmission(async (...admissionArgs) => {
                  if (!admissionArgs[0] && phase === "inside-writer") {
                    await pause();
                  }
                  return performWrite(...admissionArgs);
                }, diagnostics);
              },
            });
          });
          try {
            return await run(worker);
          } finally {
            spy.mockRestore();
          }
        },
        assertCurrent,
        signal,
      ),
  );
  return {
    release,
    async expectPending(operation: Promise<unknown>) {
      expect(
        await Promise.race([
          entered.promise.then(() => "admitted"),
          operation.then(
            () => "completed",
            () => "failed",
          ),
        ]),
      ).toBe("admitted");
    },
  };
}
