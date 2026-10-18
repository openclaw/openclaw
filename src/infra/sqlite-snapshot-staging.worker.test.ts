import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { SqliteSnapshotStagingReply } from "./sqlite-snapshot-staging.types.js";

const fixture = vi.hoisted(() => {
  const ports: { value?: import("node:worker_threads").MessageChannel } = {};
  return {
    ports,
    register:
      vi.fn<
        (
          run: (input: unknown) => Promise<SqliteSnapshotStagingReply>,
          options: { closeResource: (directory?: string) => Promise<void> },
        ) => void
      >(),
    allocate:
      vi.fn<
        ReturnType<
          typeof import("./sqlite-snapshot-staging-runtime.js").createSqliteSnapshotStagingRuntime
        >["allocate"]
      >(),
    closeRuntime: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    removed: vi.fn<(directory: string) => Promise<void>>().mockResolvedValue(undefined),
    createSession: vi.fn(() => {
      throw new Error("The controlled allocation fixture must not create a native child");
    }),
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
vi.mock("./sqlite-snapshot-staging-runtime.js", () => ({
  createSqliteSnapshotStagingRuntime: () => ({
    allocate: fixture.allocate,
    close: fixture.closeRuntime,
  }),
}));
vi.mock("./sqlite-readonly-native-resource.client.js", () => ({
  createSqliteReadOnlyNativeResourceClient: () => ({
    createSession: fixture.createSession,
    removed: fixture.removed,
  }),
}));

const directories = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    try {
      const registration = fixture.register.mock.calls[0];
      if (registration) {
        await registration[1].closeResource();
      }
      cleanup();
    } finally {
      fixture.ports.value?.port1.close();
      fixture.ports.value?.port2.close();
      vi.restoreAllMocks();
    }
  });
});

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

  // Exercise the actual registered worker handlers; only allocation and ACK are controlled.
  await import("./sqlite-snapshot-staging.worker.js");
  const registration = fixture.register.mock.calls[0];
  if (!registration) {
    throw new Error("Staging worker did not register its task and resource handlers");
  }
  const [runTask, resource] = registration;
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
  expect(retire).toHaveBeenCalledOnce();
  expect(remove).toHaveBeenCalledOnce();

  await fs.mkdir(directory);
  await fs.writeFile(sentinel, "replacement must survive");
  await resource.closeResource(directory);

  expect(await fs.readFile(sentinel, "utf8")).toBe("replacement must survive");
  expect(retire).toHaveBeenCalledOnce();
  expect(remove).toHaveBeenCalledOnce();
  expect(fixture.removed.mock.calls).toEqual([[directory], [directory]]);
});
