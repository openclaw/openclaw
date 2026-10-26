import { vi } from "vitest";
import "../../snapshot/database-backup.worker.js";

const backup = vi.hoisted(
  (): {
    handle?: Parameters<typeof import("../worker-task-server.js").serveWorkerTasks>[0];
  } => ({}),
);

// Exercise the real backup wrappers and handler on owned fixtures. Native
// process custody and snapshot isolation have their own integration suites.
vi.mock("../worker-task-server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../worker-task-server.js")>()),
  serveWorkerTasks: (handle: NonNullable<typeof backup.handle>) => {
    backup.handle = handle;
  },
}));
vi.mock("../sqlite-snapshot-source.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sqlite-snapshot-source.js")>();
  const copy = await import("../sqlite-readonly-location.js");
  return {
    ...actual,
    prepareSqliteReadOnlyLocationSync: copy.prepareSqliteReadOnlyLocationSyncInProcess,
    prepareSqliteReadOnlyLocation: (pathname: string) =>
      copy.prepareSqliteReadOnlyCopyInProcess(pathname),
  };
});
vi.mock("../worker-task-pool.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../worker-task-pool.js")>();
  const { nativeProcessTestEntrypoints } =
    await import("../native-process-runtime.test-support.js");
  const { resolveRuntimeWorkerUrl } = await import("../runtime-worker-url.js");
  return {
    ...actual,
    WorkerTaskPool: new Proxy(actual.WorkerTaskPool, {
      construct(Target, args: ConstructorParameters<typeof actual.WorkerTaskPool>) {
        // Retain real PG discovery without loading source TypeScript inside the test deadline.
        if (/\/update-candidate-state\.postgres\.worker\.[jt]s$/.test(args[0].workerUrl.pathname)) {
          return new Target({
            ...args[0],
            workerUrl: resolveRuntimeWorkerUrl(nativeProcessTestEntrypoints.updatePostgresState),
          });
        }
        if (!/\/database-backup\.worker\.[jt]s$/.test(args[0].workerUrl.pathname)) {
          return new Target(...args);
        }
        return {
          async run(input: unknown) {
            if (!backup.handle) {
              throw new Error("Backup worker handler was not registered");
            }
            return backup.handle(structuredClone(input), undefined, {
              runNativeSection: async (operation) => operation(),
              throwIfCancelled() {},
            });
          },
          async close() {},
        };
      },
    }),
  };
});
