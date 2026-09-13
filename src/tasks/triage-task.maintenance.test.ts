// Retention does not make a historical native projection a live restart blocker.
import { afterEach, expect, it, vi } from "vitest";
import type { TriageBackingObservation } from "../infra/triage-backing.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createInMemoryTaskRegistryStore } from "../test-utils/task-registry-store.js";
import { getTaskById } from "./task-registry.js";
import {
  getInspectableActiveTaskRestartBlockers,
  reconcileInspectableTasks,
} from "./task-registry.maintenance.js";
import { configureTaskRegistryRuntime } from "./task-registry.store.js";
import type { TaskRecord } from "./task-registry.types.js";
import { resetTaskRegistryForTests } from "./task-runtime.test-helpers.js";
import { triageTaskProgressSummary } from "./triage-task.js";

const mocks = vi.hoisted(() => ({ observe: vi.fn() }));
vi.mock("../infra/triage-backing.js", () => ({ observeTriageBacking: mocks.observe }));
afterEach(() => {
  resetTaskRegistryForTests();
  vi.restoreAllMocks();
});

const live: TriageBackingObservation = {
  kind: "matched",
  phase: "running",
  helper: "live",
  executor: "live",
  lifetime: "matched",
  control: "unavailable",
};
const cases: Array<{
  name: string;
  observation: TriageBackingObservation;
  raw?: boolean;
  throws?: boolean;
  blocks: boolean;
}> = [
  { name: "live", observation: live, raw: true, blocks: true },
  { name: "settling", observation: { ...live, phase: "closing" }, raw: true, blocks: true },
  {
    name: "released",
    observation: { kind: "absent", reason: "missing-row" },
    raw: true,
    blocks: false,
  },
  { name: "dead executor", observation: { ...live, executor: "dead" }, raw: true, blocks: false },
  { name: "prior boot", observation: { ...live, lifetime: "mismatch" }, raw: true, blocks: false },
  {
    name: "unknown executor",
    observation: { ...live, executor: "unknown" },
    raw: true,
    blocks: false,
  },
  {
    name: "uncertain settlement",
    observation: { ...live, phase: "uncertain" },
    raw: true,
    blocks: false,
  },
  { name: "replaced requester", observation: live, raw: false, blocks: false },
  { name: "missing custom hook", observation: live, blocks: false },
  { name: "unavailable store", observation: live, throws: true, blocks: false },
];
it.each(cases)(
  "retains $name projection without inventing restart liveness",
  async ({ observation, raw, throws, blocks }) => {
    await withOpenClawTestState({ layout: "state-only", prefix: "triage-blocker-" }, async () => {
      resetTaskRegistryForTests();
      mocks.observe.mockReturnValue(observation);
      const at = Date.now() - 60 * 60_000;
      const scope = {
        taskId: "triage-task-1",
        runtime: "cli" as const,
        taskKind: "triage_repair",
        sourceId: "generation-1",
        runId: "generation-1",
        ownerKey: "",
        scopeKind: "system" as const,
        requesterSessionKey: "",
      };
      const task: TaskRecord = {
        ...scope,
        status: "running",
        task: "Repair installation",
        createdAt: at,
        startedAt: at,
        lastEventAt: at,
        notifyPolicy: "silent",
        deliveryStatus: "not_applicable",
        detail: {
          kind: "triage_repair",
          version: 1,
          taskScope: scope,
          executionStartedAt: at,
          backing: { generation: { owner: scope.runId } },
        },
      };
      const write = vi.fn();
      configureTaskRegistryRuntime({
        store: {
          ...createInMemoryTaskRegistryStore({
            tasks: new Map([[task.taskId, task]]),
            deliveryStates: new Map(),
          }),
          ...(raw !== undefined || throws
            ? {
                matchesTaskIdentity: () => {
                  if (throws) {
                    throw new Error("read unavailable");
                  }
                  return raw;
                },
              }
            : {}),
          upsertTaskWithDeliveryState: write,
          deleteTaskWithDeliveryState: write,
          upsertDeliveryState: write,
        },
      });
      expect(getTaskById(task.taskId)?.status).toBe("running");
      write.mockClear();
      expect(reconcileInspectableTasks()).toEqual([task]);
      expect(getInspectableActiveTaskRestartBlockers().map((row) => row.taskId)).toEqual(
        blocks ? [task.taskId] : [],
      );
      if (!blocks) {
        expect(triageTaskProgressSummary(task)).toContain("unconfirmed");
      }
      expect(getTaskById(task.taskId)).toEqual(task);
      expect(write).not.toHaveBeenCalled();
    });
  },
);
