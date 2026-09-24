import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withTestTimeout } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { SQLITE_READONLY_CHILD_ARG } from "../infra/runtime-process-entrypoints.js";
import { runSqliteReadOnlyWorker } from "../infra/sqlite-readonly-worker.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import type { BrokerChild } from "../process/spawn-broker/child.js";
import { getSpawnBroker } from "../process/spawn-broker/context.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  withAgentDatabaseStartupAdmission,
  type getAgentDatabaseStartupAdmission,
} from "../state/agent-database-startup.js";
import { startGatewayServer } from "./server.js";

type AgentDatabaseStartupAdmission = NonNullable<
  ReturnType<typeof getAgentDatabaseStartupAdmission>
>;

const observed = vi.hoisted(() => ({
  brokerPid: undefined as number | undefined,
  startupParent: undefined as number | undefined,
  shutdownParent: undefined as number | undefined,
  admission: undefined as AgentDatabaseStartupAdmission | undefined,
  beforeAdopt: undefined as ((admission: AgentDatabaseStartupAdmission) => void) | undefined,
  afterAdopt: undefined as ((admission: AgentDatabaseStartupAdmission) => void) | undefined,
  closeError: undefined as Error | undefined,
  failStartup: false,
  startupWork: undefined as (() => Promise<void>) | undefined,
  closeWork: undefined as (() => Promise<void>) | undefined,
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ info: vi.fn() }),
}));

vi.mock("./server-start.js", () => ({
  startGatewayServerCore: async () => {
    const { runExec } = await import("../process/exec.js");
    const { getAgentDatabaseStartupAdmission } = await import("../state/agent-database-startup.js");
    observed.brokerPid = getSpawnBroker()?.pid;
    const admission = getAgentDatabaseStartupAdmission();
    observed.admission = admission;
    if (!admission) {
      throw new Error("Gateway startup has no database admission owner");
    }
    observed.beforeAdopt?.(admission);
    await observed.startupWork?.();
    if (observed.failStartup) {
      throw new Error("startup failed");
    }
    const admissionOwner = admission.adopt();
    observed.afterAdopt?.(admission);
    const parent = async () => {
      const result = await runExec(process.execPath, ["-e", "console.log(process.ppid)"], {
        logOutput: false,
      });
      return Number(result.stdout);
    };
    // Runtime callbacks inherit the server's execution scope across async boundaries.
    observed.startupParent = await new Promise<number>((resolve, reject) => {
      setImmediate(() => void parent().then(resolve, reject));
    });
    return {
      startupSettled: Promise.resolve(),
      getTailscaleIngressEndpoint: () => undefined,
      close: async () => {
        await observed.closeWork?.();
        if (observed.closeError) {
          throw observed.closeError;
        }
        try {
          observed.shutdownParent = await parent();
        } finally {
          await admissionOwner.stop();
        }
      },
    };
  },
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function holdAdmissionCleanup(admission: AgentDatabaseStartupAdmission) {
  const started = createDeferredCore();
  const release = createDeferredCore();
  const joined = (async () => {
    await new Promise<void>((resolve) => {
      admission.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    started.resolve();
    await release.promise;
    if (observed.brokerPid === undefined) {
      throw new Error("Admission cleanup lost its broker identity");
    }
    process.kill(observed.brokerPid, 0);
  })();
  admission.track(joined);
  return { started, release, joined };
}

describe.skipIf(process.platform === "win32")("Gateway spawn broker lifetime", () => {
  const nodeIt = process.versions.bun ? it.skip : it;
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  beforeAll(() => {
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  });
  afterAll(() => {
    Object.defineProperty(process, "platform", platform);
  });
  afterEach(() => {
    observed.beforeAdopt = undefined;
    observed.afterAdopt = undefined;
    observed.closeError = undefined;
    observed.startupWork = undefined;
    observed.closeWork = undefined;
  });

  nodeIt("owns spawning through startup callbacks and the complete shutdown join", async () => {
    const server = await startGatewayServer();
    try {
      expect(observed.brokerPid).toBeTypeOf("number");
      expect(observed.admission?.isStopped).toBe(false);
      expect(observed.startupParent).toBe(observed.brokerPid);
      expect(observed.startupParent).not.toBe(process.pid);
    } finally {
      await server.close();
    }
    expect(observed.shutdownParent).toBe(observed.brokerPid);
    expect(observed.admission?.isStopped).toBe(true);
    expect(() => process.kill(observed.brokerPid!, 0)).toThrow();
  });

  nodeIt("joins the broker when runtime startup fails", async () => {
    observed.failStartup = true;
    try {
      await expect(startGatewayServer()).rejects.toThrow("startup failed");
      expect(() => process.kill(observed.brokerPid!, 0)).toThrow();
    } finally {
      observed.failStartup = false;
    }
  });

  nodeIt.each(["shutdown", "startup failure", "shutdown failure"] as const)(
    "owns the auth read child through runtime callbacks and %s",
    async (phase) => {
      const root = tempDirs.make("openclaw-gateway-auth-worker-");
      const source = path.join(root, "source.sqlite");
      const database = new (requireNodeSqlite().DatabaseSync)(source);
      database.close();
      const read = () =>
        runSqliteReadOnlyWorker(source, {
          mode: "auth-profile-rows",
          source: "canonical",
          expectedIdentity: readDatabasePathIdentitySync(source).key,
          env: { ...process.env },
          coordinatorRuntime: { directory: path.join(root, "coordinator"), keepAlive: false },
        });
      const resume = createDeferredCore();
      let runtimeRead: Promise<unknown> | undefined;
      let child: BrokerChild | undefined;
      let spawnCount = 0;
      observed.startupWork = async () => {
        const broker = getSpawnBroker()!;
        const spawn = broker.spawn.bind(broker);
        vi.spyOn(broker, "spawn").mockImplementation((...args) => {
          const spawned = spawn(...args);
          if (args[1].includes(SQLITE_READONLY_CHILD_ARG)) {
            child = spawned;
            spawnCount += 1;
          }
          return spawned;
        });
        await read();
        runtimeRead = new Promise((resolve, reject) => {
          setImmediate(() => void resume.promise.then(read).then(resolve, reject));
        });
      };
      observed.closeWork = async () => {
        await read();
      };
      observed.failStartup = phase === "startup failure";
      try {
        if (phase === "startup failure") {
          await expect(startGatewayServer()).rejects.toThrow("startup failed");
          resume.resolve();
          await expect(runtimeRead).rejects.toThrow("scope closed");
        } else {
          const server = await startGatewayServer();
          try {
            resume.resolve();
            await runtimeRead;
            expect(child?.exitCode).toBeNull();
          } finally {
            if (phase === "shutdown failure") {
              observed.closeError = new Error("shutdown failed");
              await expect(server.close()).rejects.toThrow("shutdown failed");
            } else {
              await server.close();
            }
          }
        }
        expect(spawnCount).toBe(1);
        expect(child?.exitCode).toBe(0);
        expect(child?.connected).toBe(false);
      } finally {
        resume.resolve();
        await Promise.allSettled([runtimeRead]);
        observed.failStartup = false;
      }
    },
  );

  it("preserves Bun's native process transport", async () => {
    const bun = Object.getOwnPropertyDescriptor(process.versions, "bun");
    Object.defineProperty(process.versions, "bun", { value: "1.4.2", configurable: true });
    try {
      const server = await startGatewayServer();
      try {
        expect(observed.brokerPid).toBeUndefined();
        expect(observed.startupParent).toBe(process.pid);
      } finally {
        await server.close();
      }
      expect(observed.shutdownParent).toBe(process.pid);
    } finally {
      if (bun) {
        Object.defineProperty(process.versions, "bun", bun);
      } else {
        Reflect.deleteProperty(process.versions, "bun");
      }
    }
  });

  nodeIt.each(["beforeAdopt", "afterAdopt", "close-before-sidecars"] as const)(
    "joins an outer CLI admission before broker extinction when core fails at %s",
    async (phase) => {
      await withAgentDatabaseStartupAdmission(async (admission) => {
        const cleanup = holdAdmissionCleanup(admission);
        const failure = new Error(`core failed at ${phase}`);
        if (phase !== "close-before-sidecars") {
          observed[phase] = (coreAdmission) => {
            expect(coreAdmission).toBe(admission);
            throw failure;
          };
        }
        let settled = false;
        let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
        const starting = startGatewayServer().then((started) => {
          server = started;
          return started;
        });
        const ending =
          phase === "close-before-sidecars"
            ? starting.then((started) => {
                expect(observed.admission).toBe(admission);
                observed.closeError = failure;
                return started.close();
              })
            : starting;
        void ending.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        try {
          await withTestTimeout(cleanup.started.promise, 5_000, "Admission stop did not begin");
          await nextTurn();
          expect(settled).toBe(false);
          expect(() => process.kill(observed.brokerPid!, 0)).not.toThrow();
          cleanup.release.resolve();
          await expect(cleanup.joined).resolves.toBeUndefined();
          await expect(ending).rejects.toBe(failure);
          expect(admission.isStopped).toBe(true);
          expect(() => process.kill(observed.brokerPid!, 0)).toThrow();
        } finally {
          cleanup.release.resolve();
          await admission.stop();
          await Promise.allSettled([ending, cleanup.joined]);
          if (server && phase !== "close-before-sidecars") {
            await server.close();
          }
        }
      });
    },
  );
});
