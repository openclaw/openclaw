import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createVitestResourceOwner } from "../../scripts/lib/vitest-resource-ownership.mts";
import { resolveGatewayPort } from "../../src/config/paths.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { resolveGatewayUrlOverride } from "../../src/gateway/client-bootstrap.js";
import { reserveGatewayTestListener } from "../../src/gateway/test-helpers.listener.js";
import { captureFullEnv, withEnvAsync } from "../../src/test-utils/env.js";
import {
  acquireTestPortBlock,
  reserveTestPortListener,
  type TestPortClaim,
} from "../../src/test-utils/port-claims.js";
import * as testPorts from "../../src/test-utils/ports.js";
import { createFixtureLifetime } from "./fixture-lifetime.js";
import { createOpenClawTestInstance } from "./openclaw-test-instance.js";
import { createDeferred, withTestTimeout } from "./promise.js";
import { runQaGatewayFixture } from "./qa-gateway-cleanup.js";

describe("createOpenClawTestInstance acquisition", () => {
  it.each([
    { platform: "win32", explicit: false, advances: true },
    { platform: "win32", explicit: true, advances: false },
    { platform: "darwin", explicit: false, advances: false },
  ] as const)(
    "preserves reservation policy after $platform EACCES (explicit=$explicit)",
    async ({ platform, explicit, advances }) => {
      const port = await testPorts.getDeterministicFreePortBlock({ offsets: [0] });
      const denied = Object.assign(new Error("candidate listener denied"), { code: "EACCES" });
      const platformSpy = vi.spyOn(os, "platform").mockReturnValue(platform);
      syncBuiltinESMExports();
      const pickerSpy = vi
        .spyOn(testPorts, "getDeterministicFreePortBlock")
        .mockResolvedValueOnce(port);
      let first = true;
      let reservation: Awaited<ReturnType<typeof reserveTestPortListener>> | undefined;
      try {
        const pending = reserveTestPortListener({
          offsets: [0],
          ...(explicit ? { port } : {}),
          createListener: () => {
            const listener = net.createServer();
            if (first) {
              first = false;
              vi.spyOn(listener, "listen").mockImplementationOnce(() => {
                queueMicrotask(() => listener.emit("error", denied));
                return listener;
              });
            }
            return listener;
          },
        });
        if (advances) {
          reservation = await pending;
          expect(reservation.claim.port).not.toBe(port);
          expect(reservation.listener.listening).toBe(true);
        } else {
          await expect(pending).rejects.toBe(denied);
        }
        const released = await acquireTestPortBlock({ port, offsets: [0] });
        await released.release();
      } finally {
        platformSpy.mockRestore();
        syncBuiltinESMExports();
        pickerSpy.mockRestore();
        await reservation?.releaseListener();
        await reservation?.claim.release();
      }
    },
  );

  it.each([
    {
      name: "child-process",
      offsets: [0, 1],
      acquire: async () => {
        const instance = await createOpenClawTestInstance({ name: "initial-listener-race" });
        return { port: instance.port, cleanup: () => instance.cleanup() };
      },
    },
    {
      name: "in-process",
      offsets: [0, 1, 2, 3, 4],
      acquire: async () => {
        const reservation = await reserveGatewayTestListener();
        return { port: reservation.port, cleanup: reservation.closeUnadopted };
      },
    },
  ])(
    "retains another $name reservation when an unclaimed listener wins the probe",
    async (adapter) => {
      const competitor = net.createServer((socket) => socket.destroy());
      const exclusiveProbe = net.createServer((socket) => socket.destroy());
      let competitorClaim: TestPortClaim | undefined;
      let restoreAllocation: (() => void) | undefined;
      let reserved: { port: number; cleanup: () => Promise<void> } | undefined;
      const listen = (server: net.Server, port: number) =>
        new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
          });
        });
      const close = async (server: net.Server) => {
        if (server.listening) {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          });
        }
      };
      await runQaGatewayFixture(
        async () => {
          const competing = await reserveTestPortListener({
            offsets: adapter.offsets,
            createListener: () => competitor,
          });
          competitorClaim = competing.claim;
          const competitorPort = competitorClaim.port;
          // Bind under the claim, then retain only the socket to model an unclaimed listener.
          await competitorClaim.release();
          competitorClaim = undefined;
          const allocationSpy = vi
            .spyOn(testPorts, "getDeterministicFreePortBlock")
            .mockResolvedValueOnce(competitorPort);
          restoreAllocation = () => allocationSpy.mockRestore();
          reserved = await adapter.acquire();
          expect(competitor.listening).toBe(true);
          expect(reserved.port).not.toBe(competitorPort);
          await expect(listen(exclusiveProbe, reserved.port)).rejects.toMatchObject({
            code: "EADDRINUSE",
          });
          const abandoned = await acquireTestPortBlock({
            port: competitorPort,
            offsets: adapter.offsets,
          });
          await abandoned.release();
          // An explicitly requested port remains pinned, even when its socket is occupied.
          await expect(reserveGatewayTestListener(competitorPort)).rejects.toMatchObject({
            code: "EADDRINUSE",
          });
        },
        () => restoreAllocation?.(),
        () => close(exclusiveProbe),
        () => reserved?.cleanup(),
        () => close(competitor),
        () => competitorClaim?.release(),
        () => {
          expect(competitor.listening).toBe(false);
          expect(competitor.address()).toBeNull();
          expect(exclusiveProbe.listening).toBe(false);
        },
      );
    },
  );

  it.skipIf(process.platform !== "linux")(
    "keeps Gateway and deferred sandbox listeners outside the kernel client-port range",
    async () => {
      const [low, high] = (await fs.readFile("/proc/sys/net/ipv4/ip_local_port_range", "utf8"))
        .trim()
        .split(/\s+/u)
        .map(Number);
      const instance = await createOpenClawTestInstance({ name: "sandbox-port-allocation" });
      const sandbox = net.createServer();
      await runQaGatewayFixture(
        async () => {
          for (const port of [instance.port, instance.port + 1]) {
            expect(port < low! || port > high!, `listener ${port} overlaps ${low}–${high}`).toBe(
              true,
            );
          }
          await new Promise<void>((resolve, reject) => {
            sandbox.once("error", reject);
            sandbox.listen(instance.port + 1, "127.0.0.1", resolve);
          });
          expect(sandbox.listening).toBe(true);
        },
        () =>
          sandbox.listening
            ? new Promise<void>((resolve, reject) => {
                sandbox.close((error) => (error ? reject(error) : resolve()));
              })
            : undefined,
        () => instance.cleanup(),
      );
    },
  );

  it.each(["state", "config", "rollback failure"] as const)(
    "joins and rolls back owner cancellation during %s acquisition",
    async (stage) => {
      const controller = new AbortController();
      const cancelled = new Error("instance acquisition cancelled");
      const cleanupFailure = new Error("cancelled instance state cleanup failed");
      const entered = createDeferred();
      const released = createDeferred();
      // Deliberate failed rollback must retain this synthetic owner, not the
      // resource namespace of the runner executing the regression.
      const lifetimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "instance-cancel-owner-"));
      const lifetimeOwner = createVitestResourceOwner(lifetimeRoot);
      const lifetime = createFixtureLifetime(lifetimeRoot);
      const serverSpy = vi.spyOn(net, "createServer");
      let root: string | undefined;
      let reservation: net.Server | undefined;
      const reservationClosed = vi.fn();
      let acquired: Awaited<ReturnType<typeof createOpenClawTestInstance>> | undefined;
      let settled = false;
      const mkdtemp = fs.mkdtemp;
      const allocationSpy = vi.spyOn(fs, "mkdtemp").mockImplementation(async (...args) => {
        const allocated = await mkdtemp(...args);
        if (args[0].endsWith("instance-owner-cancel-")) {
          root = await fs.realpath(allocated);
          reservation = serverSpy.mock.results.find(
            (result) => result.type === "return" && result.value.listening,
          )?.value;
          expect(reservation?.listening).toBe(true);
          reservation?.once("close", reservationClosed);
          if (stage === "state") {
            entered.resolve();
            await released.promise;
          }
        }
        return allocated;
      });
      const writeFile = fs.writeFile;
      const writeSpy = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
        if (
          stage !== "state" &&
          root &&
          args[0] === path.join(root, "home", ".openclaw", "openclaw.json")
        ) {
          entered.resolve();
          await released.promise;
        }
        return writeFile(...args);
      });
      const rm = fs.rm;
      const cleanupSpy = vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
        if (stage === "rollback failure" && args[0] === root) {
          throw cleanupFailure;
        }
        return rm(...args);
      });
      // A variable keeps the pre-fix call type-correct while the old owner ignores
      // these options. The regression must exercise its actual acquisition path.
      const options = {
        name: "owner-cancel-acquisition",
        state: { prefix: "instance-owner-cancel-" },
        signal: controller.signal,
        verifyCleanup: lifetime.verifyCleanup,
      };
      const acquisition = lifetime.run(async () => {
        acquired = await createOpenClawTestInstance(options);
        return acquired;
      });
      const outcome = acquisition
        .then(
          () => ({ error: undefined }),
          (error: unknown) => ({ error }),
        )
        .finally(() => {
          settled = true;
        });
      try {
        await withTestTimeout(
          entered.promise,
          5_000,
          "instance acquisition did not reach its gate",
        );
        controller.abort(cancelled);
        expect(settled).toBe(false);
        expect(root).toBeDefined();
        await expect(fs.stat(root!)).resolves.toBeDefined();
        released.resolve();
        const result = await outcome;
        // Released ports can already belong to another fixture; observe our listener.
        expect(reservationClosed).toHaveBeenCalledOnce();
        expect(reservation?.listening).toBe(false);
        expect(reservation?.address()).toBeNull();
        const drained = await lifetime.cleanup().then(
          () => ({ error: undefined }),
          (error: unknown) => ({ error }),
        );
        if (stage === "rollback failure") {
          expect(result.error).toBeInstanceOf(AggregateError);
          expect((result.error as AggregateError).errors).toEqual([cancelled, cleanupFailure]);
          expect(drained.error).toBeInstanceOf(AggregateError);
          expect((drained.error as AggregateError).errors).toContain(cleanupFailure);
          expect(() => lifetimeOwner.assertReleased()).toThrow("Unreleased Vitest resource claim");
          await expect(fs.stat(root!)).resolves.toBeDefined();
        } else {
          expect(result.error).toBe(cancelled);
          expect(drained.error).toBeUndefined();
          expect(() => lifetimeOwner.assertReleased()).not.toThrow();
          await expect(fs.stat(root!)).rejects.toMatchObject({ code: "ENOENT" });
        }
        expect(acquired).toBeUndefined();
      } finally {
        released.resolve();
        await outcome;
        allocationSpy.mockRestore();
        writeSpy.mockRestore();
        cleanupSpy.mockRestore();
        serverSpy.mockRestore();
        // The unchanged owner can return an instance instead of rejecting; keep
        // that failing control finite and close its real reserved listener.
        await acquired?.cleanup();
        await lifetime.cleanup().catch(() => undefined);
        if (root) {
          await fs.rm(root, { recursive: true, force: true });
        }
        await fs.rm(lifetimeRoot, { recursive: true, force: true });
      }
    },
  );

  it.each(["state", "merge", "serialization", "write", "cleanup"] as const)(
    "cleans up available resources after %s acquisition failure",
    async (stage) => {
      const previousEnv = { ...process.env };
      const snapshot = captureFullEnv();
      const failure = new Error(`config ${stage} failed`);
      let root: string | undefined;
      let writeFailure: unknown;
      const cleanupFailure = new Error("state cleanup failed");
      const serverSpy = vi.spyOn(net, "createServer");
      let reservation: net.Server | undefined;
      const reservationClosed = vi.fn();
      const mkdtemp = fs.mkdtemp;
      const allocationSpy = vi.spyOn(fs, "mkdtemp").mockImplementation(async (...args) => {
        if (args[0].endsWith("instance-wrapper-failure-")) {
          reservation = serverSpy.mock.results.find(
            (result) => result.type === "return" && result.value.listening,
          )?.value;
          expect(reservation?.listening).toBe(true);
          reservation?.once("close", reservationClosed);
          if (stage === "state") {
            throw failure;
          }
        }
        const allocated = await mkdtemp(...args);
        if (args[0].endsWith("instance-wrapper-failure-")) {
          root = await fs.realpath(allocated);
        }
        return allocated;
      });
      const rm = fs.rm;
      const cleanupSpy = vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
        if (stage === "cleanup" && args[0] === root) {
          throw cleanupFailure;
        }
        return rm(...args);
      });
      const writeFile = fs.writeFile;
      const writeSpy = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
        if (
          stage === "write" &&
          root &&
          args[0] === path.join(root, "home", ".openclaw", "openclaw.json")
        ) {
          // A directory at the config path makes the real filesystem write reject.
          await fs.mkdir(args[0]);
          try {
            await writeFile(...args);
          } catch (error) {
            writeFailure = error;
            throw error;
          }
          return;
        }
        return writeFile(...args);
      });
      const failConfig = () => {
        expect(root).toBeDefined();
        throw failure;
      };
      const config =
        stage === "merge" || stage === "cleanup"
          ? {
              get gateway() {
                return failConfig();
              },
            }
          : stage === "serialization"
            ? { toJSON: failConfig }
            : {};
      try {
        const rejected = await createOpenClawTestInstance({
          name: "acquisition-failure",
          state: { prefix: "instance-wrapper-failure-" },
          config,
        }).catch((error: unknown) => error);
        expect(reservationClosed).toHaveBeenCalledOnce();
        expect(reservation?.listening).toBe(false);
        expect(reservation?.address()).toBeNull();
        if (stage === "write") {
          expect(writeFailure).toMatchObject({ code: "EISDIR" });
          expect(rejected).toBe(writeFailure);
        } else if (stage === "cleanup") {
          expect(rejected).toBeInstanceOf(AggregateError);
          expect((rejected as AggregateError).errors).toEqual([failure, cleanupFailure]);
        } else {
          expect(rejected).toBe(failure);
        }
        expect(process.env).toEqual(previousEnv);
        if (stage !== "state") {
          expect(root).toBeDefined();
          if (stage === "cleanup") {
            await expect(fs.stat(root!)).resolves.toBeDefined();
          } else {
            await expect(fs.stat(root!)).rejects.toMatchObject({ code: "ENOENT" });
          }
        }
      } finally {
        allocationSpy.mockRestore();
        writeSpy.mockRestore();
        cleanupSpy.mockRestore();
        serverSpy.mockRestore();
        snapshot.restore();
        if (root) {
          await fs.rm(root, { recursive: true, force: true });
        }
      }
    },
  );
});

type EndpointEnv = {
  OPENCLAW_GATEWAY_PORT?: string;
  OPENCLAW_GATEWAY_URL?: string;
};
const port = 19701;
const inheritedUrl = "wss://inherited.fixture.invalid";
const explicitUrl = "wss://explicit.fixture.invalid";
const cases: Array<{
  name: string;
  inherited: EndpointEnv;
  explicit?: EndpointEnv;
  expected: { port: number; override: { url?: string; source?: "env" } };
}> = [
  {
    name: "inherited endpoints",
    inherited: { OPENCLAW_GATEWAY_PORT: "19702", OPENCLAW_GATEWAY_URL: inheritedUrl },
    expected: { port, override: {} },
  },
  {
    name: "explicit options.env",
    inherited: { OPENCLAW_GATEWAY_PORT: "19702", OPENCLAW_GATEWAY_URL: inheritedUrl },
    explicit: { OPENCLAW_GATEWAY_PORT: "19704", OPENCLAW_GATEWAY_URL: explicitUrl },
    expected: { port: 19704, override: { url: explicitUrl, source: "env" } },
  },
  {
    name: "explicit undefined deletion",
    inherited: { OPENCLAW_GATEWAY_PORT: "19702", OPENCLAW_GATEWAY_URL: inheritedUrl },
    explicit: { OPENCLAW_GATEWAY_PORT: undefined, OPENCLAW_GATEWAY_URL: undefined },
    expected: { port, override: {} },
  },
];
const readParentEndpoints = (): EndpointEnv => ({
  OPENCLAW_GATEWAY_PORT: process.env.OPENCLAW_GATEWAY_PORT,
  OPENCLAW_GATEWAY_URL: process.env.OPENCLAW_GATEWAY_URL,
});

describe("test instance endpoint isolation", () => {
  it.each(cases)("preserves endpoint ownership with $name", async (scenario) => {
    const parent = readParentEndpoints();
    const inherited = {
      OPENCLAW_GATEWAY_PORT: undefined,
      OPENCLAW_GATEWAY_URL: undefined,
      ...scenario.inherited,
    };
    await runQaGatewayFixture(
      () =>
        withEnvAsync(inherited, async () => {
          // A supplied port skips reservation; this test never starts a child or listener.
          const instance = await createOpenClawTestInstance({
            name: "endpoint-isolation",
            port,
            env: { ...scenario.explicit, OPENCLAW_SKIP_CRON: "0" },
          });
          await runQaGatewayFixture(
            async () => {
              const config: OpenClawConfig = JSON.parse(
                await fs.readFile(instance.configPath, "utf8"),
              );
              expect(config.gateway?.port).toBe(instance.port);
              expect(instance.child).toBeUndefined();
              expect(instance.env.OPENCLAW_SKIP_CRON).toBe("0");
              for (const [key, value] of Object.entries(scenario.explicit ?? {})) {
                if (value === undefined) {
                  expect(Object.hasOwn(instance.env, key)).toBe(false);
                } else {
                  expect(instance.env[key]).toBe(value);
                }
              }
              expect(readParentEndpoints()).toEqual(inherited);
              expect(
                resolveGatewayUrlOverride({ env: instance.env, gatewayUrl: explicitUrl }),
              ).toEqual({ url: explicitUrl, source: "cli" });
              expect(
                resolveGatewayUrlOverride({ env: instance.env, localPortOverride: 19705 }),
              ).toEqual({});
              const actual = {
                port: resolveGatewayPort(config, instance.env),
                override: resolveGatewayUrlOverride({ env: instance.env }),
              };
              expect(actual, `FIXTURE_ENDPOINT_ISOLATION ${JSON.stringify(actual)}`).toEqual(
                scenario.expected,
              );
            },
            async () => {
              await instance.cleanup();
              await expect(fs.stat(instance.state.root)).rejects.toMatchObject({ code: "ENOENT" });
            },
          );
        }),
      async () => {
        expect(readParentEndpoints()).toEqual(parent);
      },
    );
  });
});
