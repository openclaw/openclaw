import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { listAgentIds } from "../agents/agent-scope.js";
import { type AgentsConfig, getRuntimeConfig, resetConfigRuntimeState } from "../config/config.js";
import { drainSystemEvents } from "../infra/system-events.js";
import { enqueueRoutedSystemEvent } from "../plugin-sdk/system-event-runtime.js";
import { deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { GatewayClient, GatewayClientRequestError } from "./client.js";
import { GatewayStartupCleanupError, rethrowGatewayStartupError } from "./server-shutdown.js";
import { createGatewayConfigOverrides } from "./test-helpers.config-runtime.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "./test-helpers.e2e.js";
import { testState } from "./test-helpers.runtime-state.js";
import {
  installGatewayTestHooks,
  waitForSystemEvent,
  withGatewayServer,
  writeSessionStore,
} from "./test-helpers.server.js";

const envBeforeSuite = {
  PATH: process.env.PATH,
  OPENCLAW_GATEWAY_PORT: process.env.OPENCLAW_GATEWAY_PORT,
  OPENCLAW_PATH_BOOTSTRAPPED: process.env.OPENCLAW_PATH_BOOTSTRAPPED,
};

installGatewayTestHooks();

async function tryListen(server: Server, port: number): Promise<NodeJS.ErrnoException | undefined> {
  return new Promise((resolve) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      resolve(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(undefined);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

async function closeListener(server: Server): Promise<void> {
  if (server.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe("Gateway test environment lifecycle", () => {
  it("owns an implicit E2E listener across startup and a rejected close", async () => {
    const configPath = process.env.OPENCLAW_CONFIG_PATH;
    assert(configPath);
    const serverModule = await import("./server.js");
    const start = serverModule.startGatewayServer;
    const entered = createDeferred<number>();
    const release = createDeferred();
    const competitor = createServer();
    let ownedServer: Awaited<ReturnType<typeof start>> | undefined;
    const startup = vi
      .spyOn(serverModule, "startGatewayServer")
      .mockImplementation(async (port, options) => {
        assert(port !== undefined);
        entered.resolve(port);
        await release.promise;
        ownedServer = await start(port, options);
        return ownedServer;
      });
    const token = "retained-listener-token";
    const acquisition = startGatewayWithClient({
      cfg: { gateway: { auth: { mode: "token", token } } },
      configPath,
      token,
    });
    void acquisition.catch(() => {});
    let closed = false;
    try {
      const port = await Promise.race([
        entered.promise,
        acquisition.then(() => {
          throw new Error("Gateway acquisition bypassed the startup boundary");
        }),
      ]);
      const collision = await tryListen(competitor, port);
      // The old helper lets this bind succeed; release it before resuming real startup.
      await closeListener(competitor);
      expect(collision?.code).toBe("EADDRINUSE");
      release.resolve();
      const started = await acquisition;
      await started.server.startupSettled;
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      await response.text();
      expect(response.ok).toBe(true);
      await disconnectGatewayClient(started.client);
      assert(ownedServer);
      const closeError = new Error("synthetic retained Gateway close");
      const close = vi.spyOn(ownedServer, "close").mockRejectedValueOnce(closeError);
      try {
        await expect(started.server.close()).rejects.toBe(closeError);
        expect((await tryListen(competitor, port))?.code).toBe("EADDRINUSE");
        expect(process.env.OPENCLAW_GATEWAY_PORT).toBe(String(port));
        expect(process.env.OPENCLAW_CONFIG_PATH).toBe(configPath);
      } finally {
        close.mockRestore();
      }
      await started.server.close();
      closed = true;
      expect(await tryListen(competitor, port)).toBeUndefined();
    } finally {
      release.resolve();
      const started = await acquisition.catch(() => undefined);
      try {
        if (started && !closed) {
          await disconnectGatewayClient(started.client);
          await started.server.close();
        }
      } finally {
        startup.mockRestore();
        await closeListener(competitor);
      }
    }
  });

  it.each(["ordinary", "retained"] as const)(
    "releases an unadopted listener after %s startup failure",
    async (outcome) => {
      const stateDir = process.env.OPENCLAW_STATE_DIR;
      assert(stateDir);
      const configPath = path.join(stateDir, "pre-adoption.json");
      const previousConfig = process.env.OPENCLAW_CONFIG_PATH;
      const previousPort = process.env.OPENCLAW_GATEWAY_PORT;
      const startupFailure = new Error("synthetic pre-adoption startup failure");
      const cleanupFailure = new Error("synthetic kernel cleanup failure");
      const failure =
        outcome === "retained"
          ? new GatewayStartupCleanupError(startupFailure, cleanupFailure)
          : startupFailure;
      let port: number | undefined;
      const startup = vi
        .spyOn(await import("./server.js"), "startGatewayServer")
        .mockImplementation(async (selectedPort) => {
          port = selectedPort;
          process.env.OPENCLAW_GATEWAY_PORT = String(selectedPort);
          throw failure;
        });
      const competitor = createServer();
      try {
        await expect(
          startGatewayWithClient({
            cfg: {},
            configPath,
            token: "pre-adoption-token",
          }),
        ).rejects.toBe(failure);
        assert(port !== undefined);
        expect(await tryListen(competitor, port)).toBeUndefined();
        if (outcome === "retained") {
          expect(process.env.OPENCLAW_CONFIG_PATH).toBe(configPath);
          expect(process.env.OPENCLAW_GATEWAY_PORT).toBe(String(port));
        } else {
          expect(process.env.OPENCLAW_CONFIG_PATH).toBe(previousConfig);
          expect(process.env.OPENCLAW_GATEWAY_PORT).toBe(previousPort);
        }
      } finally {
        startup.mockRestore();
        await closeListener(competitor);
      }
    },
  );

  it.each(["joined", "rejected"] as const)(
    "keeps adopted-listener custody with %s startup cleanup",
    async (cleanup) => {
      const stateDir = process.env.OPENCLAW_STATE_DIR;
      assert(stateDir);
      const configPath = path.join(stateDir, "adopted-startup.json");
      const previousConfig = process.env.OPENCLAW_CONFIG_PATH;
      const previousPort = process.env.OPENCLAW_GATEWAY_PORT;
      const failure = new Error("synthetic post-adoption startup failure");
      const cleanupFailure = new Error("synthetic required cleanup failure");
      const serverModule = await import("./server.js");
      const start = serverModule.startGatewayServer;
      let ownedServer: Awaited<ReturnType<typeof start>> | undefined;
      let port: number | undefined;
      const startup = vi
        .spyOn(serverModule, "startGatewayServer")
        .mockImplementation(async (selectedPort, options) => {
          port = selectedPort;
          ownedServer = await start(selectedPort, options);
          await ownedServer.startupSettled;
          const server = ownedServer;
          return rethrowGatewayStartupError(failure, async () => {
            if (cleanup === "rejected") {
              throw cleanupFailure;
            }
            await server.close();
          });
        });
      const competitor = createServer();
      const token = "adopted-startup-token";
      try {
        const error: unknown = await startGatewayWithClient({
          cfg: { gateway: { auth: { mode: "token", token } } },
          configPath,
          token,
        }).catch((reason: unknown) => reason);
        assert(port !== undefined);
        const collision = await tryListen(competitor, port);
        if (cleanup === "rejected") {
          expect(error).toBeInstanceOf(GatewayStartupCleanupError);
          expect(error).toHaveProperty("errors", [failure, cleanupFailure]);
          expect(collision?.code).toBe("EADDRINUSE");
          expect(process.env.OPENCLAW_CONFIG_PATH).toBe(configPath);
          expect(process.env.OPENCLAW_GATEWAY_PORT).toBe(String(port));
        } else {
          expect(error).toBe(failure);
          expect(collision).toBeUndefined();
          expect(process.env.OPENCLAW_CONFIG_PATH).toBe(previousConfig);
          expect(process.env.OPENCLAW_GATEWAY_PORT).toBe(previousPort);
        }
      } finally {
        startup.mockRestore();
        await closeListener(competitor);
        await ownedServer?.close();
      }
    },
  );

  it.each(["connect error", "start error"] as const)(
    "joins %s client cleanup before rejecting acquisition",
    async (failureMode) => {
      await withGatewayServer(async ({ port }) => {
        // oxlint-disable-next-line typescript/unbound-method -- Each call binds the acquired client.
        const { start, stopAndWait } = GatewayClient.prototype;
        const startError = new Error("client start failed after allocating its socket");
        let stopAcquiredClient: (() => Promise<void>) | undefined;
        let stopping: Promise<void> | undefined;
        let stopSettled = false;
        const startSpy = vi.spyOn(GatewayClient.prototype, "start").mockImplementation(function (
          this: GatewayClient,
        ) {
          stopAcquiredClient = () => stopAndWait.call(this, { timeoutMs: 1_000 });
          start.call(this);
          if (failureMode === "start error") {
            throw startError;
          }
        });
        const stopSpy = vi
          .spyOn(GatewayClient.prototype, "stopAndWait")
          .mockImplementation(function (this: GatewayClient, options) {
            // Observe the actual client completion without holding its socket.
            stopping = stopAndWait.call(this, options).then(() => {
              stopSettled = true;
            });
            return stopping;
          });

        await runQaGatewayFixture(
          async () => {
            const failure: unknown = await connectGatewayClient({
              url: `ws://127.0.0.1:${port}`,
              token:
                failureMode === "connect error"
                  ? "wrong-gateway-token-1234567890"
                  : "test-gateway-token-1234567890",
            }).then(
              () => undefined,
              (error: unknown) => error,
            );
            if (failureMode === "connect error") {
              expect(failure).toBeInstanceOf(GatewayClientRequestError);
              expect(failure).toMatchObject({
                details: { code: "AUTH_TOKEN_MISMATCH" },
              });
            } else {
              expect(failure).toBe(startError);
            }
            expect(stopSpy).toHaveBeenCalledExactlyOnceWith({ timeoutMs: 1_000 });
            expect(stopSettled).toBe(true);
          },
          async () => {
            // The pre-fix helper can reject without owning a stop at all.
            await stopAcquiredClient?.();
            await stopping;
          },
          () => stopSpy.mockRestore(),
          () => startSpy.mockRestore(),
        );
      });
    },
  );

  it("records the process-wide startup environment", async () => {
    await withGatewayServer(async ({ port }) => {
      expect(process.env.OPENCLAW_GATEWAY_PORT).toBe(String(port));
      expect(process.env.OPENCLAW_PATH_BOOTSTRAPPED).toBe("1");
    });
  });

  it("restores startup-owned environment before the next test", () => {
    expect({
      PATH: process.env.PATH,
      OPENCLAW_GATEWAY_PORT: process.env.OPENCLAW_GATEWAY_PORT,
      OPENCLAW_PATH_BOOTSTRAPPED: process.env.OPENCLAW_PATH_BOOTSTRAPPED,
    }).toEqual(envBeforeSuite);
  });

  it.each([
    { scope: "per-sender", sessionKey: "agent:ops:work", queueKey: "agent:ops:work" },
    { scope: "global", sessionKey: "global", queueKey: "agent:ops:global" },
  ])(
    "reads $scope system events from the fixture's configured owner",
    async ({ scope, sessionKey, queueKey }) => {
      const actual = await vi.importActual<typeof import("../config/io.js")>("../config/io.js");
      testState.agentsConfig = { ownership: "explicit", entries: { main: {}, ops: {} } };
      testState.agentConfig = { systemAgent: { agentId: "ops" } };
      testState.sessionConfig = { scope, mainKey: "work" };
      resetConfigRuntimeState();
      // Publish fixture overrides before the SDK's real config reader observes them.
      createGatewayConfigOverrides(actual).getRuntimeConfig();
      enqueueRoutedSystemEvent("fixture system event", { sessionKey, agentId: "ops" });
      try {
        await expect(waitForSystemEvent()).resolves.toEqual(["fixture system event"]);
      } finally {
        drainSystemEvents(queueKey);
      }
    },
  );

  it.each([
    { fixture: "session store", roster: "entries" },
    { fixture: "config mock", roster: "entries" },
    { fixture: "session store", roster: "list" },
  ])(
    "keeps authored config readable while the $fixture publishes canonical $roster overrides",
    async ({ fixture, roster }) => {
      const actual = await vi.importActual<typeof import("../config/io.js")>("../config/io.js");
      const { writeConfigFile } = createGatewayConfigOverrides(actual);
      const configPath = process.env.OPENCLAW_CONFIG_PATH!;
      const workspace = path.dirname(configPath);
      const agents = {
        ownership: "explicit",
        entries: { main: {}, authored: {} },
        defaults: { userTimezone: "UTC", timeoutSeconds: 90 },
      } satisfies AgentsConfig;
      await writeConfigFile({ agents, session: { reset: { idleMinutes: 30 } } });
      const fixtureEntries = { main: {}, fixture: { workspace } };
      testState.agentsConfig =
        roster === "list"
          ? { list: [{ id: "main" }, { id: "fixture", workspace }] }
          : { ownership: "explicit", entries: fixtureEntries };
      testState.agentConfig = { workspace, timeoutSeconds: 45 };
      const readAuthoredConfig = () =>
        actual.loadConfig({ pin: false, skipPluginValidation: true, skipShellEnvFallback: true });
      const readIdleMinutes = () => readAuthoredConfig().session?.reset?.idleMinutes;
      expect(readIdleMinutes()).toBe(30);
      const writeFile = fs.writeFile.bind(fs);
      const writeSpy = vi.spyOn(fs, "writeFile").mockImplementation(async (file, data, options) => {
        // Schedule the background reader after open: a direct path write has
        // already truncated the live config; a staged descriptor has not.
        const handle = file === configPath ? await fs.open(file, "w") : undefined;
        try {
          expect([30, 60]).toContain(readIdleMinutes());
          await writeFile(handle ?? file, data, options);
        } finally {
          await handle?.close();
        }
      });

      try {
        if (fixture === "session store") {
          testState.sessionStorePath = path.join(path.dirname(configPath), "sessions.json");
          testState.sessionConfig = { reset: { idleMinutes: 60 } };
          await writeSessionStore({ entries: {} });
        } else {
          await writeConfigFile({ agents, session: { reset: { idleMinutes: 60 } } });
        }
        expect(readIdleMinutes()).toBe(60);
        const realConfig = actual.getRuntimeConfig();
        expect(realConfig.agents?.entries).toEqual(fixtureEntries);
        expect(realConfig.agents?.list).toBeUndefined();
        expect(realConfig.agents?.defaults).toMatchObject({
          userTimezone: "UTC",
          workspace,
          timeoutSeconds: 45,
        });
        expect(realConfig.session?.store).toBe(testState.sessionStorePath);
        expect(getRuntimeConfig()).toEqual(realConfig);
        const authoredConfig = readAuthoredConfig();
        expect(listAgentIds(authoredConfig)).toEqual(["main", "authored"]);
        expect(authoredConfig.agents?.defaults).toMatchObject(agents.defaults);
        expect(JSON.parse(await fs.readFile(configPath, "utf8")).agents).toEqual(agents);
      } finally {
        writeSpy.mockRestore();
      }
    },
  );

  it("restores startup-owned environment when a direct E2E server closes", async () => {
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      throw new Error("OPENCLAW_STATE_DIR is required");
    }
    setTestEnvValue("PATH", process.env.PATH ?? "");
    deleteTestEnvValue("OPENCLAW_PATH_BOOTSTRAPPED");
    const envBeforeServer = {
      PATH: process.env.PATH,
      OPENCLAW_GATEWAY_PORT: process.env.OPENCLAW_GATEWAY_PORT,
      OPENCLAW_PATH_BOOTSTRAPPED: process.env.OPENCLAW_PATH_BOOTSTRAPPED,
    };
    const token = "test-gateway-token-1234567890";
    for (const attempt of ["first", "second"]) {
      const started = await startGatewayWithClient({
        cfg: { gateway: { auth: { mode: "token", token } } },
        configPath: path.join(stateDir, "openclaw.json"),
        token,
      });

      try {
        expect(process.env.OPENCLAW_GATEWAY_PORT).toBe(String(started.port));
        expect(process.env.OPENCLAW_PATH_BOOTSTRAPPED).toBe("1");
      } finally {
        await disconnectGatewayClient(started.client).catch(() => undefined);
        await started.server.close({
          reason: `${attempt} direct E2E environment proof complete`,
        });
      }

      expect({
        PATH: process.env.PATH,
        OPENCLAW_GATEWAY_PORT: process.env.OPENCLAW_GATEWAY_PORT,
        OPENCLAW_PATH_BOOTSTRAPPED: process.env.OPENCLAW_PATH_BOOTSTRAPPED,
      }).toEqual(envBeforeServer);
    }
  });
});
