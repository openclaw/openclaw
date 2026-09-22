import { setImmediate as nextTurn } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withTestTimeout } from "../../test/helpers/promise.js";
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
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ info: vi.fn() }),
}));

vi.mock("./server-start.js", () => ({
  startGatewayServerCore: async () => {
    const { getSpawnBroker } = await import("../process/spawn-broker/context.js");
    const { runExec } = await import("../process/exec.js");
    const { getAgentDatabaseStartupAdmission } = await import("../state/agent-database-startup.js");
    observed.brokerPid = getSpawnBroker()?.pid;
    const admission = getAgentDatabaseStartupAdmission();
    observed.admission = admission;
    if (!admission) {
      throw new Error("Gateway startup has no database admission owner");
    }
    observed.beforeAdopt?.(admission);
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

  it.each(["beforeAdopt", "afterAdopt", "close-before-sidecars"] as const)(
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
