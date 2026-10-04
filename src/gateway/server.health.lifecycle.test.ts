import "../test-utils/prepare-compiled-subprocesses.js";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";

type HealthHook = () => void | Promise<void>;
let drainHealthCleanup: (() => Promise<void>) | undefined;
let healthImport: Promise<unknown> | undefined;

afterEach(async () => {
  try {
    // A timed-out import still runs. Join it before resetting the mock registry;
    // collectHealthFixture fences the canceled test before it can inject faults.
    await healthImport;
    // A red health cleanup can skip the remaining owner hook. Drain it only
    // after recording the failure, so this regression cannot leak its HOME.
    await drainHealthCleanup?.();
  } finally {
    drainHealthCleanup = undefined;
    healthImport = undefined;
    vi.restoreAllMocks();
    vi.doUnmock("vitest");
    vi.doUnmock("./server.e2e-ws-harness.js");
    vi.doUnmock("./server-restart-sentinel.js");
    vi.resetModules();
  }
});

async function collectHealthFixture(signal: AbortSignal) {
  vi.resetModules();
  const setupHooks: HealthHook[] = [];
  const cleanupHooks: HealthHook[] = [];
  const close = vi.fn(async () => {});
  const harness = { close };
  const start = vi.fn(async () => harness);
  const vitest = await vi.importActual<typeof import("vitest")>("vitest");
  vi.doMock("vitest", () => ({
    ...vitest,
    beforeAll: (hook: HealthHook) => setupHooks.push(hook),
    afterAll: (hook: HealthHook) => cleanupHooks.push(hook),
    beforeEach: vi.fn(),
    afterEach: vi.fn(),
    describe: (_name: string, body: () => void) => body(),
    test: vi.fn(),
  }));
  // Keep the real environment lifecycle; only server acquisition is controlled.
  vi.doMock("./server.e2e-ws-harness.js", () => ({ startGatewayServerHarness: start }));
  const cleanup = async () => {
    // Vitest's default stack order stops this phase on the first rejection.
    while (cleanupHooks.length) {
      await cleanupHooks.pop()!();
    }
  };
  drainHealthCleanup = async () => {
    const errors: unknown[] = [];
    while (cleanupHooks.length) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) {
      throw new AggregateError(errors, "Health fixture recovery cleanup failed");
    }
  };
  healthImport = import("./server.health.test.js");
  await healthImport;
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

test("health teardown preserves rejected startup and removes its partial fixture state", async ({
  signal,
}) => {
  const fixture = await collectHealthFixture(signal);
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
});

test("health cleanup retains its environment until pending startup settles and the server closes", async ({
  signal,
}) => {
  const fixture = await collectHealthFixture(signal);
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
});
