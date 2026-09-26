import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeAsyncTasks } from "../plugins/runtime/runtime-tasks-async.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resetTaskFlowRegistryForTests } from "../tasks/task-runtime.test-helpers.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  resetTaskFlowRegistryForTests({ persist: false });
});

describe("Doctor maintenance with managed-flow workers", () => {
  it.each([
    { alreadyOpen: false, reload: false },
    { alreadyOpen: true, reload: false },
    { alreadyOpen: true, reload: true },
  ])(
    "completes writes and drainage with an already-open worker=$alreadyOpen after module reload=$reload",
    async ({ alreadyOpen, reload }) => {
      await withOpenClawTestState(
        { scenario: "external-service", label: "doctor-managed-worker" },
        async () => {
          openOpenClawStateDatabase();
          let flows = createRuntimeAsyncTasks().managedFlows.bindSession({
            sessionKey: "agent:main:doctor",
          });
          if (alreadyOpen) {
            await flows.list();
          }
          let enterMaintenance = beginDoctorMaintenance;
          if (reload) {
            await closeOpenClawStateDatabaseAsync();
            vi.resetModules();
            const [reloadedDoctor, reloadedTasks] = await Promise.all([
              import("./doctor-maintenance.js"),
              import("../plugins/runtime/runtime-tasks-async.js"),
            ]);
            enterMaintenance = reloadedDoctor.beginDoctorMaintenance;
            flows = reloadedTasks.createRuntimeAsyncTasks().managedFlows.bindSession({
              sessionKey: "agent:main:doctor",
            });
          }
          const maintenance = await enterMaintenance({
            options: { repair: true, nonInteractive: true },
            root: null,
            runtime: { log() {}, error() {}, exit() {} },
          });
          let flowId: string;
          try {
            flowId = await maintenance!.run(async () => {
              const created = await flows.createManaged({
                controllerId: "tests/doctor",
                goal: "Complete Doctor repair",
              });
              const createdFlowId = created.flowId;
              expect(created.revision).toBe(0);
              await expect(
                flows.finish({
                  flowId: createdFlowId,
                  expectedRevision: created.revision,
                  stateJson: { completed: true },
                }),
              ).resolves.toMatchObject({
                applied: true,
                flow: { flowId: createdFlowId, status: "succeeded", revision: 1 },
              });
              return createdFlowId;
            });
          } finally {
            await maintenance?.release();
          }
          await closeOpenClawStateDatabaseAsync();
          expect(await flows.list()).toEqual([
            expect.objectContaining({
              flowId,
              goal: "Complete Doctor repair",
              status: "succeeded",
              revision: 1,
              stateJson: { completed: true },
            }),
          ]);
          const next = await flows.createManaged({
            controllerId: "tests/doctor",
            goal: "Continue after maintenance",
          });
          expect((await flows.list()).map((flow) => flow.flowId).toSorted()).toEqual(
            [flowId, next.flowId].toSorted(),
          );
        },
      );
    },
  );
});
