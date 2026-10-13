import { beforeEach, expect, it, vi } from "vitest";
import type { SqliteReadOnlyWorkerLaunch } from "./sqlite-readonly-worker-session.js";
import type { SqliteSnapshotStagingLaunch } from "./sqlite-snapshot-staging.types.js";

const transport = vi.hoisted(() => ({
  compatible: vi.fn<(launch: SqliteReadOnlyWorkerLaunch) => boolean>(() => true),
  isRetired: vi.fn(() => false),
  run: vi.fn<(...args: unknown[]) => Promise<string>>(),
  close: vi.fn<() => Promise<void>>(),
}));
const factory = vi.hoisted(() => vi.fn());

import { createSqliteSnapshotStagingRuntime } from "./sqlite-snapshot-staging-runtime.js";

let runtime: ReturnType<typeof createSqliteSnapshotStagingRuntime>;
let launch: SqliteSnapshotStagingLaunch;
beforeEach(() => {
  launch = { cwd: "/fixture", env: { FIXTURE: "captured" }, transport: { kind: "native" } };
  transport.compatible.mockReset().mockReturnValue(true);
  transport.run.mockReset().mockResolvedValue("/fixture/snapshot");
  transport.close.mockReset().mockResolvedValue(undefined);
  transport.isRetired.mockReset().mockReturnValue(false);
  factory.mockReset().mockReturnValue(transport);
  runtime = createSqliteSnapshotStagingRuntime(factory);
});

it.each([false, true])("preserves allocation failures when cleanup fails=%s", async (fails) => {
  const allocation = Object.assign(new Error("spawn node EACCES"), { code: "EACCES" });
  const cleanup = new Error("close failed");
  transport.run.mockRejectedValueOnce(allocation);
  if (fails) {
    transport.close.mockRejectedValueOnce(cleanup);
    await expect(runtime.allocate("/fixture", false, launch, 1)).rejects.toMatchObject({
      errors: [allocation, cleanup],
      cause: allocation,
    });
  } else {
    await expect(runtime.allocate("/fixture", false, launch, 1)).rejects.toBe(allocation);
    expect(transport.close).toHaveBeenCalledOnce();
  }
});
