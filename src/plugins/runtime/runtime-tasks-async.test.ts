import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import * as workerStore from "../../state/openclaw-state-worker-store.js";
import { buildFlowRecord } from "../../tasks/task-flow-registry.records.js";
import { createRuntimeAsyncTasks } from "./runtime-tasks-async.js";

const mocks = vi.hoisted(() => ({
  ensureReady: vi.fn(),
}));

vi.mock("../../state/openclaw-state-worker-context.js", () => ({
  captureOpenClawStateWorkerContext: () => ({ admission: { assertCurrent() {} } }),
}));
vi.mock("../../tasks/task-flow-runtime-internal.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../tasks/task-flow-runtime-internal.js")>()),
  ensureTaskFlowRegistryReadyAsync: mocks.ensureReady,
}));

const input = { controllerId: "tests/creation", goal: "Synthetic flow" };
const ownerKey = "agent:main:creation";
let runOperation: MockInstance<typeof workerStore.runOpenClawStateWorkerOperation>;

function bindManagedFlows() {
  return createRuntimeAsyncTasks().managedFlows.bindSession({ sessionKey: ownerKey });
}

beforeEach(() => {
  mocks.ensureReady.mockReset();
  runOperation = vi
    .spyOn(workerStore, "runOpenClawStateWorkerOperation")
    .mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("async managed-flow creation", () => {
  it("preserves each persistence rejection as the strict creation error cause", async () => {
    const first = new Error("First synthetic persistence failure");
    const second = new Error("Second synthetic persistence failure");
    runOperation.mockRejectedValueOnce(first).mockRejectedValueOnce(second);
    const managed = bindManagedFlows();

    const outcomes = await Promise.allSettled([
      managed.createManaged(input),
      managed.createManaged(input),
    ]);

    expect(outcomes).toEqual([
      {
        status: "rejected",
        reason: expect.objectContaining({ message: "TaskFlow persistence failed.", cause: first }),
      },
      {
        status: "rejected",
        reason: expect.objectContaining({ message: "TaskFlow persistence failed.", cause: second }),
      },
    ]);
    expect(runOperation).toHaveBeenCalledTimes(2);
  });

  it("keeps ordinary persistence failures nullable for tryCreateManaged", async () => {
    runOperation.mockRejectedValue(new Error("Synthetic persistence failure"));
    await expect(bindManagedFlows().tryCreateManaged(input)).resolves.toBeNull();
    expect(runOperation).toHaveBeenCalledTimes(1);
  });

  describe.each(["tryCreateManaged", "createManaged"] as const)("%s", (method) => {
    it.each(["direct", "cause", "aggregate"] as const)(
      "propagates a %s outcome-unknown error unchanged without retrying",
      async (wrapper) => {
        const uncertain = Object.assign(new Error("Synthetic uncertain write"), {
          code: "outcome-unknown",
        });
        const error =
          wrapper === "direct"
            ? uncertain
            : wrapper === "cause"
              ? new Error("Synthetic wrapper", { cause: uncertain })
              : new AggregateError([new Error("Synthetic cleanup failure"), uncertain]);
        runOperation.mockRejectedValue(error);

        await expect(bindManagedFlows()[method](input)).rejects.toBe(error);
        expect(runOperation).toHaveBeenCalledTimes(1);
      },
    );

    it("propagates preparation errors before attempting a write", async () => {
      const error = new Error("Synthetic preparation failure");
      mocks.ensureReady.mockImplementation(() => {
        throw error;
      });
      await expect(bindManagedFlows()[method](input)).rejects.toBe(error);
      expect(runOperation).not.toHaveBeenCalled();
    });

    it("retains input validation before attempting a write", async () => {
      await expect(bindManagedFlows()[method]({ ...input, controllerId: " " })).rejects.toThrow(
        "Managed flow controllerId is required.",
      );
      expect(runOperation).not.toHaveBeenCalled();
    });

    it("returns the managed record after one successful write", async () => {
      const flow = buildFlowRecord({ ...input, ownerKey });
      runOperation.mockResolvedValue(flow);
      await expect(bindManagedFlows()[method](input)).resolves.toBe(flow);
      expect(runOperation).toHaveBeenCalledTimes(1);
    });
  });

  it("retains nullable and strict failures when a write returns no managed record", async () => {
    runOperation.mockResolvedValue(undefined);
    const managed = bindManagedFlows();
    await expect(managed.tryCreateManaged(input)).resolves.toBeNull();
    await expect(managed.createManaged(input)).rejects.toMatchObject({
      message: "TaskFlow persistence failed.",
    });
    expect(runOperation).toHaveBeenCalledTimes(2);
  });
});
