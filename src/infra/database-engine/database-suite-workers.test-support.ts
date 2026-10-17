import { afterAll, vi } from "vitest";

type RetainedPool = InstanceType<typeof import("../worker-task-pool.js").WorkerTaskPool>;
type WorkerScope = {
  pools: Map<string, RetainedPool>;
  closePools: Array<() => Promise<void>>;
  closed: boolean;
};

const { closePools, currentScope } = await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return {
    closePools: [] as Array<() => Promise<void>>,
    currentScope: new AsyncLocalStorage<WorkerScope>(),
  };
});

export function createDatabaseSuiteWorkerScope() {
  const scope: WorkerScope = { pools: new Map(), closePools: [], closed: false };
  let retirement: Promise<void> | undefined;
  return {
    run<T>(body: () => Promise<T>): Promise<T> {
      if (scope.closed) {
        return Promise.reject(new Error("Database suite worker scope is closed"));
      }
      return currentScope.run(scope, body);
    },
    close(): Promise<void> {
      if (!retirement) {
        // Fence old async continuations before real pool retirement starts. Their
        // captured scope must never attach late work to a successor test's pools.
        scope.closed = true;
        retirement = Promise.allSettled(scope.closePools.map(async (close) => close())).then(
          (results) => {
            const failures = results.flatMap((result) =>
              result.status === "rejected" ? [result.reason] : [],
            );
            if (failures.length) {
              throw new AggregateError(failures, "Database suite worker retirement failed");
            }
          },
        );
      }
      return retirement;
    },
  };
}

// Keep the real worker protocol, admission and native operations. These suites
// cover data contracts; port-command.integration.test.ts keeps one-shot custody proof.
vi.mock("../worker-task-pool.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../worker-task-pool.js")>();
  const pools = new Map<string, InstanceType<typeof actual.WorkerTaskPool>>();
  return {
    ...actual,
    WorkerTaskPool: new Proxy(actual.WorkerTaskPool, {
      construct(Target, args: ConstructorParameters<typeof actual.WorkerTaskPool>) {
        const scope = currentScope.getStore();
        if (scope?.closed) {
          throw new Error("Database suite worker scope is closed");
        }
        const [options] = args;
        const url = options.workerUrl;
        if (!/\/(?:port-command\.worker|database-backup)\.[jt]s$/.test(url.pathname)) {
          return new Target(...args);
        }
        const retained = scope?.pools ?? pools;
        let pool = retained.get(url.href);
        if (!pool) {
          pool = new Target(...args);
          (scope?.closePools ?? closePools).push(pool.close.bind(pool));
          pool = new Proxy(pool, {
            get(target, property) {
              if (property === "close") {
                return async () => {};
              }
              const value = Reflect.get(target, property, target);
              if (scope && property === "run") {
                return (...runArgs: Parameters<RetainedPool["run"]>) =>
                  scope.closed
                    ? Promise.reject(new Error("Database suite worker scope is closed"))
                    : Reflect.apply(value, target, runArgs);
              }
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
          retained.set(url.href, pool);
        }
        return pool;
      },
    }),
  };
});

afterAll(async () => {
  for (const close of closePools.splice(0)) {
    await close();
  }
});
