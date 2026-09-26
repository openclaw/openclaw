// Run-id collision cases for the detached-task lookup. Extracted from
// detached-task-runtime.test.ts under the line-cap ratchet, which requires a coherent
// sibling module rather than trimmed coverage.
import { expect, it, type Mock } from "vitest";
import { findDetachedTaskRun } from "./detached-task-runtime.js";
import type { TaskRecord } from "./task-registry.types.js";

export type RunIdCollisionLookupDeps = {
  createFakeTaskRecord: (overrides?: Partial<TaskRecord>) => TaskRecord;
  mockFindTaskByRunIdForStatus: Mock;
  mockListTasksByRunIdForStatus: Mock;
  mockListTasksForSessionKeyForStatus: Mock;
};

/** Registers the run-id collision cases into the caller's `describe` block. */
export function registerRunIdCollisionLookupTests(deps: RunIdCollisionLookupDeps): void {
  const {
    createFakeTaskRecord,
    mockFindTaskByRunIdForStatus,
    mockListTasksByRunIdForStatus,
    mockListTasksForSessionKeyForStatus,
  } = deps;

  // Run ids are not unique across runtimes, and the preferred-row lookup deprioritizes
  // only `cli`, so an older `cron` or `acp` row can be selected ahead of the row this
  // caller owns. Rejecting on that selection alone reported a live task as absent.
  it.each(["cron", "acp", "cli"] as const)(
    "finds its own task row when an older runtime=%s row shares the run id",
    (runtime) => {
      const expected = createFakeTaskRecord({
        taskId: "task-owned",
        runtime: "subagent",
        runId: "run-shared",
        childSessionKey: "agent:main:subagent:child",
        createdAt: 30,
      });
      const foreign = createFakeTaskRecord({
        taskId: `task-${runtime}-collision`,
        runtime,
        runId: "run-shared",
        childSessionKey: "agent:main:subagent:child",
        createdAt: 10,
      });
      // The shared preference selects the older foreign row, so the short-circuit
      // misses and the runtime-scoped list is what has to find the caller's own row.
      mockFindTaskByRunIdForStatus.mockReturnValue(foreign);
      mockListTasksByRunIdForStatus.mockReturnValue([foreign, expected]);

      expect(
        findDetachedTaskRun({
          runId: "run-shared",
          runtime: "subagent",
          sessionKey: "agent:main:subagent:child",
          createdAtOrAfter: 0,
        }),
      ).toEqual({ lookup: "available", task: expected });
    },
  );

  it("reports no task when only another runtime holds the run id", () => {
    const foreign = createFakeTaskRecord({
      taskId: "task-cron-only",
      runtime: "cron",
      runId: "run-foreign-only",
      childSessionKey: "agent:main:subagent:child",
      createdAt: 10,
    });
    mockFindTaskByRunIdForStatus.mockReturnValue(foreign);
    mockListTasksByRunIdForStatus.mockReturnValue([foreign]);

    // A foreign row standing alone is still an absent owner for this caller, and the
    // scoped lookup must not widen into returning another runtime's task.
    expect(
      findDetachedTaskRun({
        runId: "run-foreign-only",
        runtime: "subagent",
        sessionKey: "agent:main:subagent:child",
        createdAtOrAfter: 0,
      }),
    ).toEqual({ lookup: "available", task: undefined });
  });

  // Every runtime-scoped caller goes through this lookup, not just `subagent`. A `cli`
  // caller is the one the comparator actively deprioritizes, so it is the case most
  // likely to be shadowed by any other row sharing its run id.
  it("finds a cli caller's own row behind a preferred row of another runtime", () => {
    const expected = createFakeTaskRecord({
      taskId: "task-cli-owned",
      runtime: "cli",
      runId: "run-cli-shared",
      childSessionKey: "agent:main",
      createdAt: 40,
    });
    const foreign = createFakeTaskRecord({
      taskId: "task-subagent-collision",
      runtime: "subagent",
      runId: "run-cli-shared",
      childSessionKey: "agent:main:subagent:child",
      createdAt: 10,
    });
    // `cli` sorts last regardless of age, so the caller's own row is never preferred.
    mockFindTaskByRunIdForStatus.mockReturnValue(foreign);
    mockListTasksByRunIdForStatus.mockReturnValue([foreign, expected]);

    expect(
      findDetachedTaskRun({
        runId: "run-cli-shared",
        runtime: "cli",
        sessionKey: "agent:main",
        createdAtOrAfter: 0,
      }),
    ).toEqual({ lookup: "available", task: expected });
    expect(mockListTasksForSessionKeyForStatus).not.toHaveBeenCalled();
  });
}
