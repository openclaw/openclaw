import "../test-utils/prepare-compiled-subprocesses.js";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";

type FixtureHook = () => void | Promise<void>;
type FixtureSuite = "health" | "openresponses";
const fixtureSuites: FixtureSuite[] = ["health", "openresponses"];
let drainFixtureCleanup: (() => Promise<void>) | undefined;
let fixtureImport: Promise<unknown> | undefined;

afterEach(async () => {
  try {
    // A timed-out import still runs. Join it before resetting the mock registry;
    // collectGatewayFixture fences the canceled test before it can inject faults.
    await fixtureImport;
    // A red fixture cleanup can skip the remaining owner hook. Drain it only
    // after recording the failure, so this regression cannot leak its HOME.
    await drainFixtureCleanup?.();
  } finally {
    drainFixtureCleanup = undefined;
    fixtureImport = undefined;
    vi.restoreAllMocks();
    vi.doUnmock("vitest");
    vi.doUnmock("./server.e2e-ws-harness.js");
    vi.doUnmock("./server-restart-sentinel.js");
    vi.doUnmock("./test-helpers.js");
    vi.doUnmock("../infra/net/fetch-guard.js");
    vi.resetModules();
  }
});

async function collectGatewayFixture(suite: FixtureSuite, signal: AbortSignal) {
  vi.resetModules();
  const setupHooks: FixtureHook[] = [];
  const cleanupHooks: FixtureHook[] = [];
  const close = vi.fn(async () => {});
  const harness = { close };
  const start = vi.fn(async () => harness);
  const vitest = await vi.importActual<typeof import("vitest")>("vitest");
  vi.doMock("vitest", () => ({
    ...vitest,
    beforeAll: (hook: FixtureHook) => setupHooks.push(hook),
    afterAll: (hook: FixtureHook) => cleanupHooks.push(hook),
    beforeEach: vi.fn(),
    afterEach: vi.fn(),
    describe: vi.fn(),
    test: vi.fn(),
  }));
  // Keep the real environment lifecycle; only server acquisition is controlled.
  vi.doMock("./server.e2e-ws-harness.js", () => ({ startGatewayServerHarness: start }));
  if (suite === "openresponses") {
    vi.doMock("./test-helpers.js", async () => ({
      ...(await vi.importActual<typeof import("./test-helpers.js")>("./test-helpers.js")),
      getGatewayTestPort: async () => 0,
      startGatewayServerWithRetries: async () => ({ port: 0, server: await start() }),
    }));
  }
  const cleanup = async () => {
    // Vitest's default stack order stops this phase on the first rejection.
    while (cleanupHooks.length) {
      await cleanupHooks.pop()!();
    }
  };
  drainFixtureCleanup = async () => {
    const errors: unknown[] = [];
    while (cleanupHooks.length) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) {
      throw new AggregateError(errors, "Gateway fixture recovery cleanup failed");
    }
  };
  fixtureImport =
    suite === "health" ? import("./server.health.test.js") : import("./openresponses-http.test.js");
  await fixtureImport;
  signal.throwIfAborted();
  return {
    close,
    harness,
    start,
    cleanup,
    setup: async () => {
      for (const hook of setupHooks) {
        await hook();
      }
    },
  };
}

test.for(fixtureSuites)(
  "%s teardown preserves rejected startup and removes its partial fixture state",
  async (suite, { signal }) => {
    const fixture = await collectGatewayFixture(suite, signal);
    const failure = new Error("injected startup failure before harness publication");
    let partialState: string | undefined;
    fixture.start.mockImplementation(async () => {
      partialState = path.join(process.env.HOME!, "partial-health-startup");
      await fs.mkdir(partialState);
      throw failure;
    });
    await expect(fixture.setup()).rejects.toBe(failure);
    expect(existsSync(partialState!)).toBe(true);
    await expect(fixture.cleanup()).resolves.toBeUndefined();
    expect(existsSync(partialState!)).toBe(false);
    expect(fixture.close).not.toHaveBeenCalled();
  },
);

test.for(fixtureSuites)(
  "%s cleanup retains its environment until pending startup settles and the server closes",
  async (suite, { signal }) => {
    const fixture = await collectGatewayFixture(suite, signal);
    const started = createDeferred();
    const releaseStartup = createDeferred<typeof fixture.harness>();
    const releaseClose = createDeferred();
    fixture.start.mockImplementation(() => {
      started.resolve();
      return releaseStartup.promise;
    });
    fixture.close.mockImplementation(() => releaseClose.promise);
    const setup = fixture.setup();
    let cleanup: Promise<unknown> | undefined;
    try {
      await Promise.race([started.promise, setup]);
      expect(fixture.start).toHaveBeenCalledOnce();
      const home = process.env.HOME!;
      let cleanupSettled = false;
      // Drive the schedule after a beforeAll timeout: its async body is still
      // running when Vitest enters afterAll. No wall-clock timeout is needed.
      cleanup = fixture.cleanup().then(
        () => {
          cleanupSettled = true;
        },
        (error: unknown) => {
          cleanupSettled = true;
          return error;
        },
      );
      await setImmediate();
      expect.soft(cleanupSettled).toBe(false);
      expect.soft(process.env.HOME === home).toBe(true);
      expect.soft(existsSync(home)).toBe(true);
      releaseStartup.resolve(fixture.harness);
      await setup;
      await setImmediate();
      expect.soft(fixture.close).toHaveBeenCalledOnce();
      expect.soft(cleanupSettled).toBe(false);
      expect.soft(process.env.HOME === home).toBe(true);
      expect.soft(existsSync(home)).toBe(true);
      releaseClose.resolve();
      expect.soft(await cleanup).toBeUndefined();
      expect.soft(existsSync(home)).toBe(false);
    } finally {
      releaseStartup.resolve(fixture.harness);
      releaseClose.resolve();
      await Promise.allSettled([setup, cleanup]);
    }
  },
);
