import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import type { GatewayServer } from "./server-public.js";
import * as workers from "./server-worker-environment-startup.js";
import { startClaimedGateway } from "./test-helpers.listener.js";

// Prepare the cold module graph outside the real lock-wait proof.
await import("./server-start.js");

it.for([
  ["clearLocalTurnClaimsAfterRestartAsync", "release"],
  ["clearLocalTurnClaimsAfterRestartAsync", "exhaust"],
  ["clearLocalTurnClaimsAfterRestartAsync", "fatal"],
  ["clearLocalTurnClaimsAfterRestartAsync", "unknown"],
] as const)("%s: %s", { timeout: 90_000 }, async ([_operation, mode]) => {
  const state = await createOpenClawTestState({
    label: `worker-recovery-${mode}`,
    layout: "home",
    env: {
      OPENCLAW_GATEWAY_PASSWORD: undefined,
      OPENCLAW_GATEWAY_TOKEN: undefined,
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
      VITEST: "1",
    },
  });
  state.applyEnv();
  await state.writeConfig({
    gateway: { mode: "local", auth: { mode: "token", token: "worker-recovery-test-token" } },
    plugins: { enabled: false },
    cron: { enabled: false, triggers: { enabled: false } },
    discovery: { mdns: { mode: "off" } },
    logging: { file: state.path("gateway.log") },
  });
  const claim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
  const retryObserved = createDeferredCore<"retry">();
  const failure =
    mode === "unknown"
      ? Object.assign(new Error("worker write outcome is unknown"), {
          cause: Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }),
          code: "SQLITE_WORKER_OUTCOME_UNKNOWN",
        })
      : new Error("disk I/O error");
  let attempts = 0;
  let blocker: DatabaseSync | undefined;
  let server: GatewayServer | undefined;
  const load = workers.loadGatewayWorkerEnvironmentStartupState;
  const loader = vi
    .spyOn(workers, "loadGatewayWorkerEnvironmentStartupState")
    .mockImplementation(async () => {
      const startup = await load();
      const contend = async <T>(recover: () => Promise<T>): Promise<T> => {
        attempts += 1;
        if (mode === "fatal" || mode === "unknown") {
          throw failure;
        }
        if (attempts === 1) {
          blocker = new DatabaseSync(resolveOpenClawStateSqlitePath(state.env));
          blocker.exec("BEGIN IMMEDIATE");
        }
        try {
          return await recover();
        } catch (error) {
          retryObserved.resolve("retry");
          throw error;
        }
      };
      const store = startup.placementStore;
      const recover = store.clearLocalTurnClaimsAfterRestartAsync.bind(store);
      vi.spyOn(store, "clearLocalTurnClaimsAfterRestartAsync").mockImplementation(() =>
        contend(recover),
      );
      return startup;
    });
  const { startGatewayServer } = await import("./server.js");
  const starting = startClaimedGateway(claim, () =>
    startGatewayServer(claim.port, {
      auth: { mode: "token", token: "worker-recovery-test-token" },
      bind: "loopback",
      controlUiEnabled: false,
      sidecarStartup: "start",
    }),
  ).then((value) => (server = value));
  void starting.catch(() => {});
  try {
    if (mode !== "fatal" && mode !== "unknown") {
      await expect(Promise.race([retryObserved.promise, starting])).resolves.toBe("retry");
      expect(blocker?.isTransaction).toBe(true);
      if (mode === "release") {
        blocker!.exec("ROLLBACK");
      }
    }
    if (mode === "release") {
      await starting;
      await vi.waitFor(
        async () => {
          const response = await fetch(`http://127.0.0.1:${claim.port}/readyz`, {
            signal: AbortSignal.timeout(2_000),
          });
          expect(response.status, await response.text()).toBe(200);
        },
        { timeout: 20_000 },
      );
    } else if (mode === "fatal" || mode === "unknown") {
      await expect(starting).rejects.toBe(failure);
    } else {
      await expect(starting).rejects.toThrow(
        /database is locked by another process or connection.*openclaw doctor.*openclaw gateway status --deep/,
      );
    }
    expect(attempts).toBe({ release: 2, fatal: 1, exhaust: 5, unknown: 1 }[mode]);
  } finally {
    blocker?.close();
    await starting.catch(() => {});
    await server?.close({ reason: "worker recovery contention proof complete" });
    await claim.release();
    loader.mockRestore();
    await state.cleanup();
  }
});
