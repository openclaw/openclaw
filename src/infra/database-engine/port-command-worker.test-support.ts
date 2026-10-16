import { vi } from "vitest";

const worker = vi.hoisted(
  (): {
    handle?: Parameters<typeof import("../worker-task-server.js").serveWorkerTasks>[0];
  } => ({}),
);

// Keep the command's real handler and SQL while avoiding a fresh isolate for each phase.
// Backup, snapshot, proxy, and foreign-owner workers retain their native transports.
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  parentPort: {},
  workerData: { openclawPortCommand: true },
}));
vi.mock("../worker-task-server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../worker-task-server.js")>()),
  serveWorkerTasks: (handle: NonNullable<typeof worker.handle>) => {
    worker.handle = handle;
  },
}));
vi.mock("../worker-task-pool.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../worker-task-pool.js")>();
  const native = await import("@openclaw/worker-runtime/worker");
  return {
    ...actual,
    WorkerTaskPool: new Proxy(actual.WorkerTaskPool, {
      construct(Target, args: ConstructorParameters<typeof actual.WorkerTaskPool>) {
        if (!/\/port-command\.worker\.[jt]s$/.test(args[0].workerUrl.pathname)) {
          return new Target(...args);
        }
        let pending: Promise<unknown> | undefined;
        return {
          run(input: unknown, options: { signal?: AbortSignal }) {
            const handle = worker.handle;
            if (!handle) {
              throw new Error("Port command worker handler was not registered");
            }
            const sections = native.createWorkerNativeSectionState();
            let active = true;
            const cancel = () => native.cancelWorkerNativeSections(sections);
            const control = native.createWorkerTaskControl(sections, () => active);
            options.signal?.addEventListener("abort", cancel, { once: true });
            pending = native.withWorkerTaskNativeSectionScope(
              sections,
              () => active,
              async () => {
                try {
                  options.signal?.throwIfAborted();
                  return structuredClone(await handle(structuredClone(input), undefined, control));
                } catch (error) {
                  options.signal?.throwIfAborted();
                  // Match the native transport's failed reply, including its error classification.
                  throw new actual.WorkerTaskError(
                    error instanceof Error ? error.message : String(error),
                    "failed",
                  );
                } finally {
                  active = false;
                  options.signal?.removeEventListener("abort", cancel);
                  await native.waitForWorkerNativeSections(sections);
                }
              },
            );
            return pending;
          },
          async close() {
            await pending?.catch(() => undefined);
          },
        };
      },
    }),
  };
});
