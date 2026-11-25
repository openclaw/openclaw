import { beforeEach, expect, it, vi } from "vitest";
import { createEnteredGate } from "../agents/entered-gate.test-support.js";
import { createSqliteSnapshotStagingRuntime } from "./sqlite-snapshot-staging-runtime.js";
import type { SqliteSnapshotStagingLaunch } from "./sqlite-snapshot-staging.types.js";

function session(captured: SqliteSnapshotStagingLaunch) {
  return {
    compatible: (other: SqliteSnapshotStagingLaunch) => captured.env.FIXTURE === other.env.FIXTURE,
    isRetired: () => false,
    run: vi.fn<(...args: unknown[]) => Promise<string>>().mockResolvedValue("/fixture/snapshot"),
    close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
}
const factory = vi.fn(session);
let transport: ReturnType<typeof session>;
let runtime: ReturnType<typeof createSqliteSnapshotStagingRuntime>;
let launch: SqliteSnapshotStagingLaunch;
const allocate = (id: number, context = launch) => runtime.allocate("/fixture", false, context, id);
beforeEach(() => {
  launch = { cwd: "/fixture", env: { FIXTURE: "captured" }, transport: { kind: "native" } };
  transport = session(launch);
  factory.mockReset().mockReturnValue(transport);
  runtime = createSqliteSnapshotStagingRuntime(factory);
});

it("joins failed allocation cleanup before the next allocation", async () => {
  const cleanupGate = createEnteredGate();
  const failure = new Error("allocation failed");
  transport.run.mockRejectedValueOnce(failure);
  transport.close.mockImplementationOnce(cleanupGate.wait);
  const failed = expect(allocate(1)).rejects.toBe(failure);
  await cleanupGate.entered;
  const next = allocate(2);
  expect(transport.run).toHaveBeenCalledOnce();
  cleanupGate.release();
  await failed;
  const directory = await next;
  expect(transport.run).toHaveBeenCalledTimes(2);
  await directory.retire();
  await runtime.close();
});

it("preserves both allocation and cleanup failures", async () => {
  const allocation = Object.assign(new Error("spawn node EACCES"), { code: "EACCES" });
  const cleanup = new Error("close failed");
  transport.run.mockRejectedValueOnce(allocation);
  transport.close.mockRejectedValueOnce(cleanup);
  await expect(allocate(1)).rejects.toMatchObject({
    errors: [allocation, cleanup],
    cause: allocation,
  });
});

it("retires each launch context after its last directory and retries a failed close", async () => {
  const sessions: ReturnType<typeof session>[] = [];
  factory.mockImplementation((captured: SqliteSnapshotStagingLaunch) => {
    const worker = session(captured);
    sessions.push(worker);
    return worker;
  });
  const report = await allocate(1);
  const inspection = await allocate(2, { ...launch, env: { FIXTURE: "inspection" } });
  const sibling = await allocate(3);
  expect(factory).toHaveBeenCalledTimes(2);

  await report.retire();
  expect(sessions[0]!.close).not.toHaveBeenCalled();
  await inspection.retire();
  expect(sessions[1]!.close).toHaveBeenCalledOnce();
  expect(sessions[0]!.close).not.toHaveBeenCalled();
  await expect(runtime.close()).rejects.toThrow("still has retained directories");

  const failure = new Error("native close failed");
  sessions[0]!.close.mockRejectedValueOnce(failure);
  await expect(sibling.retire()).rejects.toBe(failure);
  await sibling.retire();
  // A close retry must not replay native directory retirement.
  expect(sessions[0]!.run).toHaveBeenCalledTimes(4);
  expect(sessions[0]!.close).toHaveBeenCalledTimes(2);
  await runtime.close();
});
