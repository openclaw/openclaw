import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { useSqliteTempDirs } from "./sqlite-shard-lifecycle.test-support.js";
import type { createSqliteSnapshotStagingRuntime } from "./sqlite-snapshot-staging-runtime.js";
import type { SqliteSnapshotStagingReply } from "./sqlite-snapshot-staging.types.js";

type Runtime = ReturnType<typeof createSqliteSnapshotStagingRuntime>;
type RunTask = (input: unknown) => Promise<SqliteSnapshotStagingReply>;
type Resource = { closeResource: (directory?: string) => Promise<void> };

const fixture = vi.hoisted(() => {
  const ports: { value?: import("node:worker_threads").MessageChannel } = {};
  return {
    ports,
    register: vi.fn<(run: RunTask, options: Resource) => void>(),
    allocate: vi.fn<Runtime["allocate"]>(),
    removed: vi.fn<(directory: string) => Promise<void>>().mockResolvedValue(undefined),
  };
});

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  const { SQLITE_NATIVE_RESOURCE_PORT } =
    await import("./sqlite-readonly-native-resource.types.js");
  const ports = (fixture.ports.value ??= new actual.MessageChannel());
  return { ...actual, workerData: { [SQLITE_NATIVE_RESOURCE_PORT]: ports.port1 } };
});
vi.mock("./worker-task-server.js", () => ({ serveOwnedWorkerTasks: fixture.register }));
// mock-isolation: Controlled allocations exercise removal acknowledgement without starting native sessions.
vi.mock("./sqlite-snapshot-staging-runtime.js", () => ({
  createSqliteSnapshotStagingRuntime: () => ({
    allocate: fixture.allocate,
    close: async () => {},
  }),
}));
// mock-isolation: Removal receipts are injected and unexpected native child creation must fail this fixture.
vi.mock("./sqlite-readonly-native-resource.client.js", () => ({
  createSqliteReadOnlyNativeResourceClient: () => ({
    createSession: () => {
      throw new Error("Controlled allocation must not create a native child");
    },
    removed: fixture.removed,
  }),
}));

const directories = useSqliteTempDirs(
  () => fixture.register.mock.calls[0]?.[1].closeResource(),
  () => {
    fixture.ports.value?.port1.close();
    fixture.ports.value?.port2.close();
    vi.restoreAllMocks();
  },
);

it("retries only the removal acknowledgement and preserves a replacement directory", async () => {
  const root = directories.make("staging-removal-ack-");
  const directory = path.join(root, "snapshot");
  const sentinel = path.join(directory, "sentinel.txt");
  await fs.mkdir(directory);
  await fs.writeFile(sentinel, "original snapshot");
  const retire = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  fixture.allocate.mockResolvedValue({ directory, retire });
  const failure = new Error("native removal receipt was not acknowledged");
  fixture.removed.mockRejectedValueOnce(failure);
  const remove = vi.spyOn(fs, "rm");

  await import("./sqlite-snapshot-staging.worker.js");
  const [runTask, resource] = fixture.register.mock.calls[0]!;
  expect(
    await runTask({
      type: "allocate",
      root,
      preparationId: 1,
      allowLegacyWorker: false,
      launch: { cwd: root, env: {}, transport: { kind: "native" } },
    }),
  ).toEqual({ type: "allocated", directory });

  await expect(resource.closeResource(directory)).rejects.toBe(failure);
  await expect(fs.stat(directory)).rejects.toHaveProperty("code", "ENOENT");
  expect([retire.mock.calls.length, remove.mock.calls.length]).toEqual([1, 1]);

  await fs.mkdir(directory);
  await fs.writeFile(sentinel, "replacement must survive");
  await resource.closeResource(directory);

  expect(await fs.readFile(sentinel, "utf8")).toBe("replacement must survive");
  expect([retire.mock.calls.length, remove.mock.calls.length]).toEqual([1, 1]);
  expect(fixture.removed.mock.calls).toEqual([[directory], [directory]]);
});
