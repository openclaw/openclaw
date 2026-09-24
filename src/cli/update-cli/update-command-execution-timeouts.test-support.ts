import { expect, it, vi } from "vitest";
import { executeMutableUpdate } from "./update-command-execution.js";
import {
  executionParams,
  mocks,
  successfulUpdate,
} from "./update-command-execution.test-support.js";

export function registerExecutionTimeoutTests() {
  it.each(
    (["package", "git"] as const).flatMap((kind) =>
      [undefined, 30_000].map((timeoutMs) => ({ kind, timeoutMs })),
    ),
  )(
    "preserves aggregate work intent at $kind activation ($timeoutMs)",
    async ({ kind, timeoutMs }) => {
      // No installed service is part of this routing-only fixture. Retained-service
      // readiness and admitted-executor ownership are exercised by dedicated cases.
      mocks.maybeStopService.mockResolvedValue({
        stopped: false,
        inspected: true,
        runtimeInspected: true,
        running: false,
      });
      const budgets = await import("../../infra/update-finalization-budget.js");
      const budget = vi
        .spyOn(budgets, "resolveUpdateFinalizationTimeoutMs")
        .mockResolvedValue(180_000);
      mocks.runPackageUpdate.mockImplementation(async ({ beforeActivate }) => {
        await beforeActivate();
        return successfulUpdate;
      });
      mocks.runGitUpdate.mockImplementation(
        async (
          params: Parameters<typeof import("./update-command-git.js").updateGitInstall>[0],
        ) => {
          if (!params.inspectGitTarget || !params.beforeGitMutation) {
            throw new Error("Expected both real Git admission callbacks");
          }
          const target = { schemaVersions: { state: 15, agent: 19 } };
          await params.inspectGitTarget(target);
          await params.beforeGitMutation(target);
          return { ...successfulUpdate, mode: "git" };
        },
      );

      const execution = await executeMutableUpdate({
        ...executionParams(kind),
        timeoutMs,
        updateStepTimeoutMs: timeoutMs ?? 30 * 60_000,
      });

      expect(execution?.result.status, JSON.stringify(execution?.result)).toBe("ok");
      expect(execution?.mutationStarted).toBe(true);
      expect(mocks.prepareMutableUpdate).toHaveBeenCalledTimes(2);
      expect(mocks.prepareMutableUpdate.mock.calls.at(-1)?.[1]).toBe(
        timeoutMs === undefined ? undefined : 180_000,
      );
      expect(budget).toHaveBeenCalledTimes(timeoutMs === undefined ? 0 : 1);
    },
  );
}
