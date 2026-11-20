import path from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withinTest, withTestTimeout } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { SQLITE_READONLY_CHILD_ARG } from "../infra/runtime-process-entrypoints.js";
import { runSqliteReadOnlyWorker } from "../infra/sqlite-readonly-worker.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import type { BrokerChild } from "../process/spawn-broker/child.js";
import { getSpawnBroker, runWithSpawnBroker } from "../process/spawn-broker/context.js";
import { runWithProcessCleanupBudget } from "../process/supervisor/cleanup-budget.js";
import * as processSupervisor from "../process/supervisor/index.js";
import type { ManagedRun } from "../process/supervisor/types.js";
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
  broker: undefined as ReturnType<typeof getSpawnBroker>,
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

// mock-isolation: Replaces Gateway startup to observe the spawn broker without booting a server.
vi.mock("./server-start.js", () => ({
  startGatewayServerCore: async () => {
    const { runExec } = await import("../process/exec.js");
    const { getAgentDatabaseStartupAdmission } = await import("../state/agent-database-startup.js");
    observed.broker = getSpawnBroker();
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
      const result = await runWithSpawnBroker(
        process.versions.bun ? undefined : getSpawnBroker(),
        () => runExec(process.execPath, ["-e", "console.log(process.ppid)"], { logOutput: false }),
      );
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
    expect(observed.broker).toBeDefined();
    process.kill(observed.broker!.pid!, 0);
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

  it.each(process.versions.bun ? [true] : [false, true])(
    "owns startup callbacks and shutdown with native Bun transport=%s",
    async (native) => {
      const bun = Object.getOwnPropertyDescriptor(process.versions, "bun");
      if (native) {
        Object.defineProperty(process.versions, "bun", { value: "1.4.3", configurable: true });
      }
      try {
        const server = await startGatewayServer();
        const parent = native ? process.pid : observed.broker?.pid;
        try {
          if (native) {
            expect(observed.broker?.pid).toBeUndefined();
          } else {
            expect(observed.broker?.pid).toBeTypeOf("number");
            expect(observed.admission?.isStopped).toBe(false);
            expect(observed.startupParent).not.toBe(process.pid);
          }
          expect(observed.startupParent).toBe(parent);
        } finally {
          await server.close();
        }
        expect(observed.shutdownParent).toBe(parent);
        if (!native) {
          expect(observed.admission?.isStopped).toBe(true);
          expect(() => process.kill(observed.broker!.pid!, 0)).toThrow();
        }
      } finally {
        if (bun) {
          Object.defineProperty(process.versions, "bun", bun);
        } else {
          Reflect.deleteProperty(process.versions, "bun");
        }
      }
    },
  );

  nodeIt.each(["shutdown", "startup failure", "shutdown failure"] as const)(
    "owns the auth read child through runtime callbacks and %s",
    async (phase) => {
      const root = tempDirs.make("openclaw-gateway-auth-worker-");
      const source = path.join(root, "source.sqlite");
      new (requireNodeSqlite().DatabaseSync)(source).close();
      const read = () =>
        runSqliteReadOnlyWorker(source, {
          mode: "auth-profile-rows",
          source: "canonical",
          expectedIdentity: readDatabasePathIdentitySync(source).key,
          env: { ...process.env },
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
        expect(child?.connected).toBe(false);
        expect(child?.pid).toBeTypeOf("number");
        expect(() => process.kill(child!.pid!, 0)).toThrow();
        expect(() => process.kill(observed.broker!.pid!, 0)).toThrow();
      } finally {
        resume.resolve();
        await Promise.allSettled([runtimeRead]);
        observed.failStartup = false;
      }
    },
  );

  nodeIt.each(["beforeAdopt", "afterAdopt", "close-before-sidecars", "close-at-deadline"] as const)(
    "joins an outer CLI admission before broker extinction when core fails at %s",
    async (phase) => {
      await withAgentDatabaseStartupAdmission(async (admission) => {
        const cleanup = holdAdmissionCleanup(admission);
        const failure = new Error(`core failed at ${phase}`);
        const closing = phase.startsWith("close-");
        const bounded = phase === "close-at-deadline";
        if (phase === "beforeAdopt" || phase === "afterAdopt") {
          observed[phase] = (coreAdmission) => {
            expect(coreAdmission).toBe(admission);
            throw failure;
          };
        }
        let settled = false;
        const starting = startGatewayServer();
        const ending = closing
          ? starting.then((started) => {
              expect(observed.admission).toBe(admission);
              observed.closeError = failure;
              if (bounded) {
                vi.useFakeTimers();
              }
              return runWithProcessCleanupBudget(
                { deadline: performance.now() + 1_000, warn: vi.fn() },
                () => started.close({ exitAfterClose: bounded }),
              );
            })
          : starting;
        const markSettled = () => {
          settled = true;
        };
        void ending.then(markSettled, markSettled);
        try {
          await withTestTimeout(cleanup.started.promise, 5_000, "Admission stop did not begin");
          await nextTurn();
          expect(settled).toBe(false);
          expect(() => process.kill(observed.broker!.pid!, 0)).not.toThrow();
          if (bounded) {
            await vi.advanceTimersByTimeAsync(1_000);
            expect(settled).toBe(true);
            await expect(ending).rejects.toThrow(/database-admission/);
            await expect(ending).rejects.toHaveProperty("errors.0", failure);
            vi.useRealTimers();
          }
          cleanup.release.resolve();
          await expect(cleanup.joined).resolves.toBeUndefined();
          if (bounded) {
            await observed.broker?.close();
          } else {
            await expect(ending).rejects.toBe(failure);
            expect(() => process.kill(observed.broker!.pid!, 0)).toThrow();
          }
          expect(admission.isStopped).toBe(true);
        } finally {
          vi.useRealTimers();
          cleanup.release.resolve();
          await admission.stop();
          await Promise.allSettled([ending, cleanup.joined]);
        }
      });
    },
  );

  it("retires the broker and admission after the supervisor join rejects", async () => {
    const bun = Object.getOwnPropertyDescriptor(process.versions, "bun");
    // Select the broker lifetime on Bun too; the core still uses native command transport.
    if (bun) {
      Reflect.deleteProperty(process.versions, "bun");
      observed.startupWork = async () => {
        Object.defineProperty(process.versions, "bun", bun);
      };
    }
    const failure = new Error("supervisor cleanup failed");
    const shutdown = vi
      .spyOn(processSupervisor, "shutdownProcessSupervisor")
      .mockRejectedValue(failure);
    try {
      const server = await startGatewayServer();
      const close = vi.spyOn(observed.broker!, "close");
      const [outcome] = await Promise.allSettled([server.close()]);
      expect(close).toHaveBeenCalledOnce();
      expect(observed.admission?.isStopped).toBe(true);
      expect(() => process.kill(observed.broker!.pid!, 0)).toThrow();
      expect(outcome).toHaveProperty("reason", failure);
    } finally {
      shutdown.mockRestore();
      await observed.admission?.stop();
      await observed.broker?.close();
      if (bun) {
        Object.defineProperty(process.versions, "bun", bun);
      }
    }
  });

  it("settles an active command before retiring runtime transports after core close fails", async ({
    signal,
  }) => {
    const ready = createDeferredCore();
    let run: ManagedRun | undefined;
    let release: (() => Promise<void>) | undefined;
    observed.startupWork = async () => {
      // Only Gateway transport selection is Linux-specific; children use the real host platform.
      Object.defineProperty(process, "platform", platform);
      const supervisor = processSupervisor.getProcessSupervisor();
      release = supervisor.acquireScopeCleanup("shutdown-command", { processTree: "required-all" });
      run = await supervisor.spawn({
        mode: "child",
        scopeKey: "shutdown-command",
        argv: [
          process.execPath,
          "-e",
          `
          process.on("SIGTERM", () => {
            process.stdout.write("settled\\n", () => process.exit(0));
          });
          setInterval(() => {}, 1000);
          process.stdout.write("ready\\n");
        `,
        ],
        onStdout: (chunk) => {
          if (chunk.includes("ready")) {
            ready.resolve();
          }
        },
      });
      await withinTest(ready.promise, signal);
    };
    const failure = new Error("core close retained connection work");
    observed.closeError = failure;
    try {
      const server = await startGatewayServer();
      const outcome = Promise.allSettled([run!.wait()]);
      await expect(
        runWithProcessCleanupBudget({ deadline: performance.now() + 5_000, warn: vi.fn() }, () =>
          server.close({ exitAfterClose: true }),
        ),
      ).rejects.toBe(failure);
      // The CLI also joins here after a failed core close, including native Bun transport.
      await processSupervisor.shutdownProcessSupervisor();
      expect(run!.activity.resultSettled).toBe(true);
      expect(await outcome).toMatchObject([
        {
          status: "fulfilled",
          value: { reason: "manual-cancel", exitCode: 0, stdout: "ready\nsettled\n" },
        },
      ]);
      await expect(run!.waitForExtinction!()).resolves.toBeUndefined();
    } finally {
      await Promise.allSettled([release?.(), processSupervisor.shutdownProcessSupervisor()]);
      Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    }
  });
});
