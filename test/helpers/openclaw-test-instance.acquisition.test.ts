import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
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

const occupied = { code: "EADDRINUSE" };

function listen(server: net.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function close(server: net.Server): Promise<void> {
  if (server.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function assertClaimReleased(port: number, offsets: number[]) {
  await (await acquireTestPortBlock({ port, offsets })).release();
}

async function assertRoot(root: string | undefined, retained: boolean) {
  const pending = expect(fs.stat(root!));
  await (retained
    ? pending.resolves.toBeDefined()
    : pending.rejects.toMatchObject({ code: "ENOENT" }));
}

function observeAcquisition(
  stage: string,
  failure: Error,
  cleanupFailure?: Error,
  pause?: () => Promise<void>,
) {
  const state: { root?: string; writeFailure?: unknown } = {};
  let reservation: net.Server | undefined;
  const closed = vi.fn();
  const serverSpy = vi.spyOn(net, "createServer");
  const { mkdtemp, writeFile, rm } = fs;
  vi.spyOn(fs, "mkdtemp").mockImplementation(async (...args) => {
    const matches = args[0].endsWith("instance-acquisition-");
    if (matches) {
      reservation = serverSpy.mock.results.find(
        (result) => result.type === "return" && result.value.listening,
      )?.value;
      expect(reservation?.listening).toBe(true);
      reservation?.once("close", closed);
      if (stage === "state" && !pause) {
        throw failure;
      }
    }
    const allocated = await mkdtemp(...args);
    if (matches) {
      state.root = await fs.realpath(allocated);
      if (stage === "state") {
        await pause?.();
      }
    }
    return allocated;
  });
  vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
    if (state.root && args[0] === path.join(state.root, "home", ".openclaw", "openclaw.json")) {
      if (stage !== "state") {
        await pause?.();
      }
      // Exercise the real filesystem's EISDIR failure.
      if (stage === "write") {
        await fs.mkdir(args[0]);
      }
    }
    return writeFile(...args).catch((error: unknown) => {
      state.writeFailure = error;
      throw error;
    });
  });
  vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
    if (cleanupFailure && args[0] === state.root) {
      throw cleanupFailure;
    }
    return rm(...args);
  });
  return {
    state,
    expectClosed() {
      expect(closed).toHaveBeenCalledOnce();
      expect(reservation).toMatchObject({ listening: false });
    },
  };
}

const outcomeOf = (promise: Promise<unknown>) => promise.catch((error: unknown) => error);

it("closes an absent Gateway reservation while retaining its port claims", async () => {
  let reservation: net.Server | undefined;
  const createServer = net.createServer;
  const serverSpy = vi.spyOn(net, "createServer").mockImplementation((...args) => {
    const server = createServer(...args);
    server.once("listening", () => {
      reservation = server;
    });
    return server;
  });
  const competitor = createServer((socket) => socket.destroy());
  const instance = await createOpenClawTestInstance({
    name: "absent-gateway",
    reserveIdlePort: false,
  }).finally(() => serverSpy.mockRestore());
  await runQaGatewayFixture(
    async () => {
      expect(reservation?.listening).toBe(false);
      // Inspect the reserved socket, not a replacement listener on its released port.
      await listen(competitor, instance.port);
      await instance.stopGateway();
      expect(reservation).toMatchObject({ listening: false });
      expect(competitor.listening).toBe(true);
      for (const port of [instance.port, instance.port + 1]) {
        await expect(acquireTestPortBlock({ port, offsets: [0] })).rejects.toMatchObject(occupied);
      }
    },
    () => close(competitor),
    () => instance.cleanup(),
  );
  await assertClaimReleased(instance.port, [0, 1]);
});

it.each([
  { platform: "win32", explicit: false, advances: true },
  { platform: "win32", explicit: true, advances: false },
  { platform: "darwin", explicit: false, advances: false },
] as const)(
  "preserves reservation policy after $platform EACCES (explicit=$explicit)",
  async ({ platform, explicit, advances }) => {
    const port = await testPorts.getDeterministicFreePortBlock({ offsets: [0] });
    const denied = Object.assign(new Error("candidate listener denied"), { code: "EACCES" });
    vi.spyOn(os, "platform").mockReturnValue(platform);
    syncBuiltinESMExports();
    vi.spyOn(testPorts, "getDeterministicFreePortBlock").mockResolvedValueOnce(port);
    const deniedListener = net.createServer();
    vi.spyOn(deniedListener, "listen").mockImplementationOnce(() => {
      queueMicrotask(() => deniedListener.emit("error", denied));
      return deniedListener;
    });
    let reservation: Awaited<ReturnType<typeof reserveTestPortListener>> | undefined;
    try {
      const pending = reserveTestPortListener({
        offsets: [0],
        ...(explicit ? { port } : {}),
        createListener: vi.fn(() => net.createServer()).mockReturnValueOnce(deniedListener),
      });
      if (advances) {
        reservation = await pending;
        expect(reservation.claim.port).not.toBe(port);
        expect(reservation.listener.listening).toBe(true);
      } else {
        await expect(pending).rejects.toBe(denied);
      }
      await assertClaimReleased(port, [0]);
    } finally {
      vi.restoreAllMocks();
      syncBuiltinESMExports();
      await reservation?.releaseListener();
      await reservation?.claim.release();
    }
  },
);

it.each(["child-process", "in-process"])(
  "retains the %s reservation when an unclaimed listener wins the probe",
  async (kind) => {
    const offsets = kind === "child-process" ? [0, 1] : [0, 1, 2, 3, 4];
    const competitor = net.createServer((socket) => socket.destroy());
    const exclusiveProbe = net.createServer((socket) => socket.destroy());
    let competitorClaim: TestPortClaim | undefined;
    let reserved: { port: number; cleanup: () => Promise<void> } | undefined;
    await runQaGatewayFixture(
      async () => {
        const competing = await reserveTestPortListener({
          offsets,
          createListener: () => competitor,
        });
        competitorClaim = competing.claim;
        const competitorPort = competitorClaim.port;
        // Bind under the claim, then retain only the socket to model an unclaimed listener.
        await competitorClaim.release();
        competitorClaim = undefined;
        vi.spyOn(testPorts, "getDeterministicFreePortBlock").mockResolvedValueOnce(competitorPort);
        if (kind === "child-process") {
          const instance = await createOpenClawTestInstance({ name: "initial-listener-race" });
          reserved = { port: instance.port, cleanup: () => instance.cleanup() };
        } else {
          const reservation = await reserveGatewayTestListener();
          reserved = { port: reservation.port, cleanup: reservation.closeUnadopted };
        }
        expect(competitor.listening).toBe(true);
        expect(reserved.port).not.toBe(competitorPort);
        await expect(listen(exclusiveProbe, reserved.port)).rejects.toMatchObject(occupied);
        await assertClaimReleased(competitorPort, offsets);
        // An explicitly requested port remains pinned, even when its socket is occupied.
        await expect(reserveGatewayTestListener(competitorPort)).rejects.toMatchObject(occupied);
      },
      () => vi.restoreAllMocks(),
      () => close(exclusiveProbe),
      () => reserved?.cleanup(),
      () => close(competitor),
      () => competitorClaim?.release(),
      () => {
        expect(competitor.listening).toBe(false);
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
        await listen(sandbox, instance.port + 1);
        expect(sandbox.listening).toBe(true);
      },
      () => close(sandbox),
      () => instance.cleanup(),
    );
  },
);

it.each([
  ["state", true],
  ["config", true],
  ["rollback failure", true],
  ["state", false],
  ["write", false],
  ["cleanup", false],
] as const)("rolls back acquisition at %s (cancel=%s)", async (stage, cancel) => {
  const previousEnv = { ...process.env };
  const snapshot = captureFullEnv();
  const controller = new AbortController();
  const failure = new Error(cancel ? "instance acquisition cancelled" : `config ${stage} failed`);
  const cleanupFailure = new Error("state cleanup failed");
  const failsCleanup = stage === "rollback failure" || stage === "cleanup";
  const entered = createDeferred();
  const released = createDeferred();
  // Failed rollback must retain a synthetic owner, not the runner's namespace.
  const lifetimeRoot = cancel
    ? await fs.mkdtemp(path.join(os.tmpdir(), "cancel-owner-"))
    : undefined;
  const lifetimeOwner = lifetimeRoot ? createVitestResourceOwner(lifetimeRoot) : undefined;
  const lifetime = lifetimeRoot ? createFixtureLifetime(lifetimeRoot) : undefined;
  let acquired: Awaited<ReturnType<typeof createOpenClawTestInstance>> | undefined;
  let settled = false;
  const observed = observeAcquisition(
    stage,
    failure,
    failsCleanup ? cleanupFailure : undefined,
    cancel
      ? async () => {
          entered.resolve();
          await released.promise;
        }
      : undefined,
  );
  const { state } = observed;
  const options = {
    name: "owner-cancel-acquisition",
    state: { prefix: "instance-acquisition-" },
    signal: cancel ? controller.signal : undefined,
    verifyCleanup: lifetime?.verifyCleanup,
    config:
      stage === "cleanup"
        ? {
            get gateway() {
              throw failure;
            },
          }
        : {},
  };
  const acquire = async () => {
    acquired = await createOpenClawTestInstance(options);
    return acquired;
  };
  const acquisition = lifetime ? lifetime.run(acquire) : acquire();
  const outcome = outcomeOf(acquisition).finally(() => {
    settled = true;
  });
  try {
    if (cancel) {
      await withTestTimeout(entered.promise, 5_000, "instance acquisition did not reach its gate");
      controller.abort(failure);
      expect(settled).toBe(false);
      await assertRoot(state.root, true);
      released.resolve();
    }
    const result = await outcome;
    observed.expectClosed();
    if (failsCleanup) {
      expect(result).toBeInstanceOf(AggregateError);
      expect(result).toHaveProperty("errors", [failure, cleanupFailure]);
    } else if (stage === "write") {
      expect(state.writeFailure).toMatchObject({ code: "EISDIR" });
      expect(result).toBe(state.writeFailure);
    } else {
      expect(result).toBe(failure);
    }
    if (lifetime && lifetimeOwner) {
      const drained = await outcomeOf(lifetime.cleanup());
      if (failsCleanup) {
        expect(drained).toBeInstanceOf(AggregateError);
        expect(drained).toHaveProperty("errors", expect.arrayContaining([cleanupFailure]));
        expect(() => lifetimeOwner.assertReleased()).toThrow("Unreleased Vitest resource claim");
      } else {
        expect(drained).toBeUndefined();
        expect(() => lifetimeOwner.assertReleased()).not.toThrow();
      }
    }
    if (cancel || stage !== "state") {
      await assertRoot(state.root, failsCleanup);
    }
    expect(acquired).toBeUndefined();
    if (!cancel) {
      expect(process.env).toEqual(previousEnv);
    }
  } finally {
    released.resolve();
    await outcome;
    vi.restoreAllMocks();
    // Close the pre-fix control's incorrectly returned instance as well.
    await acquired?.cleanup();
    await lifetime?.cleanup().catch(() => undefined);
    snapshot.restore();
    if (state.root) {
      await fs.rm(state.root, { recursive: true, force: true });
    }
    if (lifetimeRoot) {
      await fs.rm(lifetimeRoot, { recursive: true, force: true });
    }
  }
});

type EndpointEnv = {
  OPENCLAW_GATEWAY_PORT?: string;
  OPENCLAW_GATEWAY_URL?: string;
};
const port = 19701;
const inheritedUrl = "wss://inherited.fixture.invalid";
const explicitUrl = "wss://explicit.fixture.invalid";
const endpoints = (value?: string, url?: string): EndpointEnv => ({
  OPENCLAW_GATEWAY_PORT: value,
  OPENCLAW_GATEWAY_URL: url,
});
const readParentEndpoints = () =>
  endpoints(process.env.OPENCLAW_GATEWAY_PORT, process.env.OPENCLAW_GATEWAY_URL);

it.each([
  ["inherited endpoints", {}, port, {}],
  ["explicit env", endpoints("19704", explicitUrl), 19704, { url: explicitUrl, source: "env" }],
  ["explicit undefined deletion", endpoints(), port, {}],
] as const)("preserves endpoint ownership with %s", async (_, explicit, expectedPort, override) => {
  const parent = readParentEndpoints();
  const inherited = endpoints("19702", inheritedUrl);
  await withEnvAsync(inherited, async () => {
    // A supplied port skips reservation; this test never starts a child or listener.
    const instance = await createOpenClawTestInstance({
      name: "endpoint-isolation",
      port,
      env: { ...explicit, OPENCLAW_SKIP_CRON: "0" },
    });
    await runQaGatewayFixture(
      async () => {
        const config: OpenClawConfig = JSON.parse(await fs.readFile(instance.configPath, "utf8"));
        const env = instance.env;
        expect(config.gateway?.port).toBe(instance.port);
        expect(instance).toMatchObject({ child: undefined, env: { OPENCLAW_SKIP_CRON: "0" } });
        for (const [key, value] of Object.entries(explicit)) {
          if (value === undefined) {
            expect(Object.hasOwn(env, key)).toBe(false);
          } else {
            expect(env[key]).toBe(value);
          }
        }
        expect(readParentEndpoints()).toEqual(inherited);
        expect(resolveGatewayUrlOverride({ env, gatewayUrl: explicitUrl })).toEqual({
          url: explicitUrl,
          source: "cli",
        });
        expect(resolveGatewayUrlOverride({ env, localPortOverride: 19705 })).toEqual({});
        expect(resolveGatewayPort(config, env)).toBe(expectedPort);
        expect(resolveGatewayUrlOverride({ env })).toEqual(override);
      },
      async () => {
        await instance.cleanup();
        await expect(fs.stat(instance.state.root)).rejects.toMatchObject({ code: "ENOENT" });
      },
    );
  });
  expect(readParentEndpoints()).toEqual(parent);
});
