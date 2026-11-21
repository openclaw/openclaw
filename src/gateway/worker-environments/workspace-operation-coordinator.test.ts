import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createWorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";

describe("worker workspace operation coordinator", () => {
  it("drains local reconciliation before forced teardown for the same environment", async () => {
    const coordinator = createWorkerWorkspaceOperationCoordinator();
    const release = createDeferred();
    const log: string[] = [];
    const reconciliation = coordinator.run("worker-1", async () => {
      log.push("reconcile:start");
      await release.promise;
      log.push("reconcile:done");
    });
    await vi.waitFor(() => expect(log).toEqual(["reconcile:start"]));

    const teardown = coordinator.run("worker-1", async () => {
      log.push("teardown");
    });
    await Promise.resolve();
    expect(log).toEqual(["reconcile:start"]);

    release.resolve();
    await Promise.all([reconciliation, teardown]);
    expect(log).toEqual(["reconcile:start", "reconcile:done", "teardown"]);
  });
  it("cancels a queued operation without overtaking the preceding writer", async () => {
    const coordinator = createWorkerWorkspaceOperationCoordinator();
    const entered = createDeferred();
    const release = createDeferred();
    const first = coordinator.run("worker", async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const controller = new AbortController();
    const cancelledTask = vi.fn(async () => {});
    const cancelled = coordinator.run("worker", cancelledTask, controller.signal);
    const reason = new Error("queued worker owner closed");
    controller.abort(reason);
    await expect(cancelled).rejects.toBe(reason);
    const followingTask = vi.fn(async () => {});
    const following = coordinator.run("worker", followingTask);
    await Promise.resolve();
    expect(followingTask).not.toHaveBeenCalled();
    release.resolve();
    await Promise.all([first, following]);
    expect(cancelledTask).not.toHaveBeenCalled();
    expect(followingTask).toHaveBeenCalledOnce();
  });

  it("joins an entered mutation after cancellation before admitting another writer", async () => {
    const coordinator = createWorkerWorkspaceOperationCoordinator();
    const entered = createDeferred();
    const release = createDeferred();
    const controller = new AbortController();
    let settled = false;
    const first = coordinator
      .run(
        "worker",
        async () => {
          entered.resolve();
          await release.promise;
        },
        controller.signal,
      )
      .finally(() => {
        settled = true;
      });
    await entered.promise;
    controller.abort();
    const nextTask = vi.fn(async () => {});
    const next = coordinator.run("worker", nextTask);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(nextTask).not.toHaveBeenCalled();
    release.resolve();
    await Promise.all([first, next]);
    expect(nextTask).toHaveBeenCalledOnce();
  });
});
