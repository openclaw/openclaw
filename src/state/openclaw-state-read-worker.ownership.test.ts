// Register shared pool mocks before modules that consume them.
// oxfmt-ignore
import { emptyReply, mock, queueTask, source } from "./openclaw-state-read-worker.test-harness.js";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  acquireGatewayStateOwner,
  assertStateDatabaseAccessAllowed,
} from "../infra/gateway-state-owner.js";
import { createDeferredCore } from "../shared/deferred.js";
import { executeExistingOpenClawStateRead } from "./openclaw-state-db-readonly.js";

let now: number;
beforeEach(() => {
  vi.useFakeTimers();
  now = 0;
  // Advance ownership age independently: an overdue interval has not run yet.
  vi.spyOn(performance, "now").mockImplementation(() => now);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function ownedSource() {
  const fixture = source();
  const owner = acquireGatewayStateOwner({
    databasePath: fixture.pathname,
    payload: {
      pid: process.pid,
      createdAt: new Date().toISOString(),
      configPath: path.join(fixture.root, "openclaw.json"),
      role: "gateway",
    },
  });
  return { ...fixture, owner };
}

async function completeRead(options: ReturnType<typeof source>["options"]) {
  const task = queueTask();
  task.result.resolve(emptyReply);
  const result = await executeExistingOpenClawStateRead(options, { type: "fleet.list" });
  await task.captured;
  return result;
}

it.each(["submission", "dispatch"] as const)(
  "refuses expired ownership at %s even when the monitor tick is late",
  async (boundary) => {
    const { options, pathname, owner } = ownedSource();
    const dispatch = createDeferredCore();
    let readSettled: Promise<unknown> = Promise.resolve();
    try {
      await expect(completeRead(options)).resolves.toEqual(emptyReply);
      if (boundary === "submission") {
        const open = vi.spyOn(fs, "openSync");
        now = 999;
        await expect(completeRead(options)).resolves.toEqual(emptyReply);
        expect(open.mock.calls.filter(([target]) => target === owner.path)).toHaveLength(0);
        open.mockRestore();
        fs.unlinkSync(owner.path);
        fs.writeFileSync(owner.path, "replacement");
        await expect(completeRead(options)).resolves.toEqual(emptyReply);
        now = 1000;
        const submittedBefore = mock.runTask.mock.calls.length;
        const unexpectedTask = queueTask();
        unexpectedTask.result.resolve(emptyReply);
        await expect(
          executeExistingOpenClawStateRead(options, { type: "fleet.list" }),
        ).rejects.toThrow(/could not be verified|Shared-state read and cleanup failed/);
        expect(mock.runTask).toHaveBeenCalledTimes(submittedBefore);
        expect(() => assertStateDatabaseAccessAllowed(pathname)).toThrow("could not be verified");
      } else {
        const task = queueTask(dispatch.promise);
        const settled = executeExistingOpenClawStateRead(options, { type: "fleet.list" }).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        readSettled = settled;
        await task.submitted;
        fs.unlinkSync(owner.path);
        fs.writeFileSync(owner.path, "replacement");
        now = 1000;
        const received = vi.fn();
        void task.captured.then(
          (request) => {
            received(request);
            task.result.resolve(emptyReply);
          },
          () => undefined,
        );
        dispatch.resolve();
        await expect(task.captured).rejects.toThrow("could not be verified");
        expect(await settled).toHaveProperty("error");
        expect(received).not.toHaveBeenCalled();
      }
    } finally {
      dispatch.resolve();
      await readSettled;
      owner.release();
    }
  },
);

it("retries an intact owner's read after one transient verification error without poisoning strict access", async () => {
  const { options, pathname, owner } = ownedSource();
  const originalOpen = fs.openSync;
  let failVerification = true;
  try {
    await completeRead(options);
    const open = vi.spyOn(fs, "openSync").mockImplementation((target, flags, mode) => {
      if (target === owner.path && failVerification) {
        failVerification = false;
        throw Object.assign(new Error("EMFILE: controlled verification failure"), {
          code: "EMFILE",
        });
      }
      return originalOpen(target, flags, mode);
    });
    now = 1000;
    // On the old implementation this callback consumes EMFILE and permanently
    // poisons the owner; without a monitor the expired read consumes it instead.
    vi.advanceTimersByTime(1000);
    await expect(executeExistingOpenClawStateRead(options, { type: "fleet.list" })).rejects.toThrow(
      /could not be verified|EMFILE|Shared-state read and cleanup failed/,
    );
    expect(failVerification).toBe(false);
    expect(mock.runTask).toHaveBeenCalledOnce();
    await expect(completeRead(options)).resolves.toEqual(emptyReply);
    expect(() => assertStateDatabaseAccessAllowed(pathname)).not.toThrow();
    open.mockRestore();
  } finally {
    vi.restoreAllMocks();
    owner.release();
  }
});
