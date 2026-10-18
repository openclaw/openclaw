import { afterAll, vi } from "vitest";

const closePools = vi.hoisted((): Array<() => Promise<void>> => []);

// Keep the real worker protocol, admission and native operations. These suites
// cover data contracts; port-command.integration.test.ts keeps one-shot custody proof.
vi.mock("../worker-task-pool.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../worker-task-pool.js")>();
  const pools = new Map<string, InstanceType<typeof actual.WorkerTaskPool>>();
  return {
    ...actual,
    WorkerTaskPool: new Proxy(actual.WorkerTaskPool, {
      construct(Target, args: ConstructorParameters<typeof actual.WorkerTaskPool>) {
        const [options] = args;
        const url = options.workerUrl;
        if (!/\/(?:port-command\.worker|database-backup)\.[jt]s$/.test(url.pathname)) {
          return new Target(...args);
        }
        let pool = pools.get(url.href);
        if (!pool) {
          pool = new Target(...args);
          closePools.push(pool.close.bind(pool));
          pool = new Proxy(pool, {
            get(target, property) {
              if (property === "close") {
                return async () => {};
              }
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
          pools.set(url.href, pool);
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
