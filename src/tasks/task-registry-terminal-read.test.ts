import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import * as taskMutationEffects from "./task-executor-mutation-effects.async.js";
import { createTaskFlowForTask } from "./task-flow-registry.js";
import * as taskRegistryListenerState from "./task-registry-listener-state.js";
import { updateTask } from "./task-registry-mutation.js";
import { prepareTaskRegistryRead } from "./task-registry-read.js";
import {
  createReadTask,
  requestTasks,
  resetReadState,
  withReadState,
} from "./task-registry-read.test-support.js";
import { linkTaskToFlowById } from "./task-registry-record-api.js";
import { tasks } from "./task-registry-state.js";
import { getTaskRegistryStore, onTaskRegistryChange } from "./task-registry.store.js";
import { loadTaskRegistryStateFromSqliteReadOnly } from "./task-registry.store.sqlite.js";
import { prepareTaskFixtureRead } from "./task-registry.test-support.js";

afterEach(resetReadState);

describe("task registry terminal read preparation", () => {
  it.each(["unchanged", "newer write", "ABA"] as const)(
    "keeps registered tasks.list current after terminal publication is superseded by %s",
    async (change) => {
      await withReadState(async () => {
        const runId = `superseded-terminal-${change}`;
        const task = createReadTask(runId);
        const flow = expectDefined(createTaskFlowForTask({ task }), "terminal task flow");
        expect(linkTaskToFlowById({ taskId: task.taskId, flowId: flow.flowId })).not.toBeNull();
        await prepareTaskFixtureRead(task);
        const request = () => requestTasks(task.ownerKey);
        const terminalInstalled = createDeferred();
        const releaseEffects = createDeferred();
        const readCaptured = createDeferred();
        const finish = taskMutationEffects.finishTaskMutation;
        let held = false;
        vi.spyOn(taskMutationEffects, "finishTaskMutation").mockImplementation(async (...args) => {
          if (
            !held &&
            args[3] === task.taskId &&
            args[4].operation === "update" &&
            tasks.get(task.taskId)?.status === "succeeded"
          ) {
            held = true;
            terminalInstalled.resolve();
            await releaseEffects.promise;
          }
          return finish(...args);
        });
        const captureFence = taskRegistryListenerState.captureTaskRegistryReadFence;
        let captureRead = false;
        vi.spyOn(taskRegistryListenerState, "captureTaskRegistryReadFence").mockImplementation(
          (...args) => {
            const pending = captureFence(...args);
            if (captureRead) {
              readCaptured.resolve();
            }
            return pending;
          },
        );
        const publications: string[] = [];
        const stop = onTaskRegistryChange((event) => {
          if (event?.kind === "upserted" && event.task.taskId === task.taskId) {
            publications.push(event.task.task);
          }
        });
        const mutation = vi.spyOn(getTaskRegistryStore(), "runAgentEventMutationAsync");
        let reading: ReturnType<typeof request> | undefined;
        let readResult:
          | Promise<PromiseSettledResult<Awaited<ReturnType<typeof request>>>[]>
          | undefined;
        try {
          emitAgentEvent({
            runId,
            stream: "lifecycle",
            data: { phase: "end", endedAt: Date.now() },
          });
          await withTestTimeout(
            terminalInstalled.promise,
            5_000,
            "Terminal event reached publication",
          );
          expect(loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId)?.status).toBe(
            "succeeded",
          );
          captureRead = true;
          reading = request();
          readResult = Promise.allSettled([reading]);
          await withTestTimeout(
            readCaptured.promise,
            5_000,
            "tasks.list captured the terminal event",
          );
          if (change !== "unchanged") {
            expect(updateTask(task.taskId, { task: "Newer task write" })).not.toBeNull();
            if (change === "ABA") {
              expect(updateTask(task.taskId, { task: task.task })).not.toBeNull();
            }
          }
          const expectedTitle = change === "newer write" ? "Newer task write" : task.task;
          const competingPublications = [...publications];
          releaseEffects.resolve();
          const [outcome] = await withTestTimeout(readResult, 5_000, "Captured tasks.list settled");
          expect(loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId)).toMatchObject({
            task: expectedTitle,
            status: "succeeded",
          });
          expect(mutation).toHaveBeenCalledOnce();
          if (change === "unchanged") {
            expect(publications).toContain(task.task);
          } else {
            expect(publications).toEqual(competingPublications);
          }
          expect((await request()).mock.calls[0]).toMatchObject([
            true,
            { tasks: [{ id: task.taskId, title: expectedTitle, status: "completed" }] },
          ]);
          expect(
            outcome,
            outcome?.status === "rejected" ? String(outcome.reason) : undefined,
          ).toMatchObject({
            status: "fulfilled",
          });
          if (outcome?.status === "fulfilled") {
            expect(outcome.value.mock.calls[0]).toMatchObject([
              true,
              { tasks: [{ id: task.taskId, title: expectedTitle, status: "completed" }] },
            ]);
          }
        } finally {
          releaseEffects.resolve();
          await readResult;
          await prepareTaskRegistryRead();
          stop();
        }
      });
    },
  );
});
