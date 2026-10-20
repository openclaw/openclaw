import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import type { GatewayServer } from "./server-public.js";
import { createStartupTestState, gatewayStartupOptions } from "./server-startup.test-support.js";
import * as workers from "./server-worker-environment-startup.js";
import { startClaimedGateway } from "./test-helpers.listener.js";

// Prepare the cold module graph outside the real lock-wait proof.
await import("./server-start.js");

it.each([
  ["starts after a competing connection releases its recovery lock", "release"],
  ["fails clearly when the recovery lock outlasts the retry budget", "exhaust"],
  ["fails immediately for a non-lock recovery error", "fatal"],
] as const)("%s", { timeout: 90_000 }, async (_name, mode) => {
  await using state = await createStartupTestState(`worker-recovery-${mode}`, {
    OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
  });
  await state.writeConfig({
    gateway: { mode: "local", auth: { mode: "token", token: "worker-recovery-test-token" } },
    plugins: { enabled: false },
    cron: { enabled: false, triggers: { enabled: false } },
    discovery: { mdns: { mode: "off" } },
    logging: { file: state.path("gateway.log") },
  });
  const claim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
  const retryObserved = createDeferredCore<"retry">();
  const warnings: string[] = [];
  const failure = new Error("disk I/O error");
  let attempts = 0;
  let settled = false;
  let blocker: DatabaseSync | undefined;
  let server: GatewayServer | undefined;
  const load = workers.loadGatewayWorkerEnvironmentStartupState;
  const create = workers.createGatewayWorkerEnvironmentRuntime;
  const loader = vi
    .spyOn(workers, "loadGatewayWorkerEnvironmentStartupState")
    .mockImplementation(async () => {
      const startup = await load();
      const recover = startup.placementStore.recoverWorkerSessionToolOperationsAfterRestart.bind(
        startup.placementStore,
      );
      vi.spyOn(
        startup.placementStore,
        "recoverWorkerSessionToolOperationsAfterRestart",
      ).mockImplementation(async () => {
        attempts += 1;
        if (mode === "fatal") {
          throw failure;
        }
        if (attempts === 1) {
          blocker = new DatabaseSync(resolveOpenClawStateSqlitePath(state.env));
          blocker.exec("BEGIN IMMEDIATE");
        }
        return await recover();
      });
      return startup;
    });
  const factory = vi
    .spyOn(workers, "createGatewayWorkerEnvironmentRuntime")
    .mockImplementation((params) =>
      create({
        ...params,
        log: {
          child: (name) => {
            const log = params.log.child(name);
            return {
              ...log,
              warn: (message) => {
                log.warn(message);
                if (message.startsWith("placementTools.recover:")) {
                  warnings.push(message);
                  retryObserved.resolve("retry");
                }
              },
            };
          },
        },
      }),
    );
  const { startGatewayServer } = await import("./server.js");
  const starting = startClaimedGateway(claim, () =>
    startGatewayServer(claim.port, gatewayStartupOptions("worker-recovery-test-token")),
  )
    .then(
      (value) => {
        server = value;
        return { server: value };
      },
      (error: unknown) => ({ error }),
    )
    .finally(() => {
      settled = true;
    });
  try {
    if (mode !== "fatal") {
      await expect(Promise.race([retryObserved.promise, starting])).resolves.toBe("retry");
      expect(settled).toBe(false);
      expect(blocker?.isTransaction).toBe(true);
      expect(warnings[0]).toContain("attempt 2/5");
      if (mode === "release") {
        blocker!.exec("ROLLBACK");
        blocker!.close();
      }
    }
    const result = await starting;
    if (mode === "release") {
      if ("error" in result) {
        throw result.error;
      }
      await result.server.startupSettled;
      expect((await fetch(`http://127.0.0.1:${claim.port}/readyz`)).status).toBe(200);
      expect(attempts).toBe(2);
      expect(warnings).toHaveLength(1);
    } else {
      if (!("error" in result)) {
        throw new Error("Gateway unexpectedly started before recovery completed");
      }
      if (mode === "fatal") {
        expect(result.error).toBe(failure);
        expect(attempts).toBe(1);
        expect(warnings).toEqual([]);
      } else {
        expect(attempts).toBe(5);
        expect(warnings).toHaveLength(4);
        expect(String(result.error)).toContain(
          "database is locked by another process or connection",
        );
        expect(String(result.error)).toContain("openclaw doctor");
        expect(String(result.error)).toContain("openclaw gateway status --deep");
      }
    }
  } finally {
    if (blocker?.isOpen) {
      if (blocker.isTransaction) {
        blocker.exec("ROLLBACK");
      }
      blocker.close();
    }
    await starting;
    await server?.close({ reason: "worker recovery contention proof complete" });
    await claim.release();
    loader.mockRestore();
    factory.mockRestore();
  }
});
