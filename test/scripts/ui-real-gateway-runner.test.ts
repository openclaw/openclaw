import { ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import { Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PluginHarness } from "vitest/node";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { getVitestWorkerDescriptor } from "../../scripts/lib/vitest-worker-descriptor.mts";
import { createVitestWorkerRun } from "../../scripts/lib/vitest-worker-run.mts";
import { runRealGatewayUiTests } from "../../scripts/test-ui-real-gateway.mts";
import { withEnvAsync } from "../../src/test-utils/env.js";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { awaitGateBeforeSettlement, createDeferred, withinTest } from "../helpers/promise.js";

const fixtures = vi.hoisted(() => ({
  workers: 2,
  serial: true,
  qualified: true,
  resolveConfig: vi.fn<
    (
      options: unknown,
      config: unknown,
      harness: PluginHarness,
    ) => Promise<{
      test: { resolvedProjects: { projectConfig: { name: string; include: string[] } }[] };
    }>
  >(),
}));
// mock-isolation: Keep eager environment-based config construction out of fixed coordinator project/budget fixtures.
vi.mock("../vitest/vitest.ui-e2e-prebuilt.config.ts", () => ({
  createPrebuiltUiE2eVitestConfig: () => ({
    test: {
      maxWorkers: fixtures.workers,
      projects: [
        { test: { name: "ui-e2e-serial", include: fixtures.serial ? ["serial.test.ts"] : [] } },
        {
          test: {
            name: "ui-e2e-real-gateway",
            include: fixtures.qualified ? ["parallel.test.ts"] : [],
          },
        },
      ],
    },
  }),
}));
// Config resolution is the boundary; complete factory/hook behavior is covered by ownership tests.
vi.mock("vitest/node", async (original) => ({
  ...(await original<typeof import("vitest/node")>()),
  resolveConfig: fixtures.resolveConfig,
}));
vi.mock("../../scripts/lib/managed-child-process.mts", async (original) => ({
  ...(await original<typeof import("../../scripts/lib/managed-child-process.mts")>()),
  runManagedCommand: vi.fn(),
}));
vi.mock("../../scripts/lib/vitest-worker-run.mts", async (original) => ({
  ...(await original<typeof import("../../scripts/lib/vitest-worker-run.mts")>()),
  createVitestWorkerRun: vi.fn(),
}));
vi.mock("../../scripts/lib/vitest-worker-descriptor.mts", async (original) => ({
  ...(await original<typeof import("../../scripts/lib/vitest-worker-descriptor.mts")>()),
  getVitestWorkerDescriptor: vi.fn(),
}));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  readFile: vi.fn(),
}));
const diagnosticFixture = createFixtureLifetime();
const managed = vi.mocked(runManagedCommand);
const createWorkers = vi.mocked(createVitestWorkerRun);
const borrowWorkers = vi.fn(async (_child: ChildProcess) => {});
const disposeWorkers = vi.fn(async () => {});
const prepareWorkers = vi.fn(async () => {
  throw new Error("The coordinator must leave worker preparation to its borrowers");
});
const env = {
  OPENCLAW_UI_E2E_RUN_DESKTOP: "true",
  OPENCLAW_VITEST_INCLUDE_FILE: "/selected-tests.json",
  OPENCLAW_VITEST_POST_SHARD_INCLUDE_FILE: "/selected-after-shard.json",
  OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT: "/cache",
};
const safeReceipt = {
  cleanup: { joined: true, unjoinedWork: false, testOwnersClosed: true, listenersClosed: true },
};
const project = (args: string[] | undefined) => {
  const index = args?.indexOf("--project") ?? -1;
  return index < 0 ? undefined : args?.[index + 1];
};

beforeEach(() => {
  fixtures.workers = 2;
  fixtures.serial = true;
  fixtures.qualified = true;
  fixtures.resolveConfig.mockReset().mockImplementation(async () => ({
    test: {
      resolvedProjects: [
        {
          projectConfig: {
            name: "ui-e2e-serial",
            include: fixtures.serial ? ["serial.test.ts"] : [],
          },
        },
        {
          projectConfig: {
            name: "ui-e2e-real-gateway",
            include: fixtures.qualified ? ["parallel.test.ts"] : [],
          },
        },
      ],
    },
  }));
  borrowWorkers.mockReset().mockResolvedValue(undefined);
  disposeWorkers.mockReset().mockResolvedValue(undefined);
  prepareWorkers.mockClear();
  vi.mocked(getVitestWorkerDescriptor).mockReset();
  createWorkers.mockReset().mockImplementation((_env, parent, preset) => ({
    descriptor: {
      directory: parent?.directory ?? "/fixture/workers",
      preset: parent ? (parent.preset ?? "full") : (preset ?? "full"),
    },
    prepare: prepareWorkers,
    borrow() {
      throw new Error("The coordinator must use a joined worker invocation");
    },
    async withBorrower<T>(run: (onReady: (child: ChildProcess) => void) => Promise<T>) {
      let joined: Promise<void> | undefined;
      try {
        return await run((child) => {
          joined = borrowWorkers(child);
        });
      } finally {
        await joined;
      }
    },
    dispose: disposeWorkers,
  }));
  managed.mockReset().mockResolvedValue(0);
  vi.mocked(fs.readFile).mockReset().mockResolvedValue(JSON.stringify(safeReceipt));
});
afterEach(async () => {
  // Timed-out bodies must join before their shared stdout mocks are restored.
  try {
    await diagnosticFixture.cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});

it.each([
  {
    active: "ui-e2e-serial-standalone",
    omitted: "ui-e2e-real-gateway",
    include: ["ui/src/e2e/desktop-resize.real-gateway.e2e.test.ts"],
  },
  { active: "ui-e2e-real-gateway-standalone", omitted: "ui-e2e-serial", include: [] },
  { active: undefined, omitted: "ui-e2e-serial", include: [] },
])("selects only final native projects ($active)", async ({ active, omitted, include }) => {
  fixtures.resolveConfig.mockResolvedValue({
    test: {
      resolvedProjects: [
        { projectConfig: { name: omitted, include } },
        ...(active ? [{ projectConfig: { name: active, include: ["final.test.ts"] } }] : []),
      ],
    },
  });
  await expect(runRealGatewayUiTests([], env)).resolves.toBe(0);
  expect(fixtures.resolveConfig).toHaveBeenCalledExactlyOnceWith(
    { config: false },
    expect.objectContaining({ test: expect.any(Object) }),
    expect.any(PluginHarness),
  );
  expect(managed.mock.calls.map(([call]) => project(call.args)).filter(Boolean)).toEqual(
    active ? [active] : [],
  );
  expect(
    managed.mock.calls.some(([call]) =>
      call.args?.includes("scripts/test-desktop-resize-real.mts"),
    ),
  ).toBe(true);
  expect(createWorkers).not.toHaveBeenCalled();
});

// Exercise the real Logger/streams while keeping native config resolution at its boundary.
it.for([
  { rejectConfig: false, rejectOutput: false },
  { rejectConfig: true, rejectOutput: false },
  { rejectConfig: false, rejectOutput: true },
  { rejectConfig: true, rejectOutput: true },
  { rejectConfig: true, rejectOutput: true, sameError: true },
])(
  "joins config diagnostics before admission (%j)",
  ({ rejectConfig, rejectOutput, sameError }, { signal }) => {
    signal.throwIfAborted();
    return diagnosticFixture.run(async () => {
      signal.throwIfAborted();
      const outputError = new Error("output rejected");
      const configError = sameError ? outputError : new Error("config rejected");
      const outputEnding = createDeferred();
      const marker = "fixture config diagnostic";
      const stdoutWrite = process.stdout.write.bind(process.stdout);
      let flush: ((error?: Error | null) => void) | undefined;
      let output: Writable | undefined;
      const destination = process.stdout;
      const originalListeners = destination.rawListeners("error");
      const sentinel = vi.fn();
      try {
        destination.once("error", sentinel);
        const baselineListeners = destination.rawListeners("error");
        let errorListener: ((error: Error) => void) | undefined;
        vi.spyOn(process.stdout, "write").mockImplementation((chunk, encoding, callback) => {
          if (String(chunk).includes(marker)) {
            flush = typeof encoding === "function" ? encoding : callback;
            const added = destination
              .rawListeners("error")
              .filter((listener) => !baselineListeners.includes(listener));
            errorListener = added.length === 1 ? added[0] : undefined;
            return true;
          }
          return typeof encoding === "function"
            ? stdoutWrite(chunk, encoding)
            : stdoutWrite(chunk, encoding, callback);
        });
        const resolve = fixtures.resolveConfig.getMockImplementation()!;
        fixtures.resolveConfig.mockImplementation(async (...args) => {
          const harness = args[2];
          expect(harness.logger.outputStream).toBeInstanceOf(Writable);
          output = harness.logger.outputStream;
          expect(output).not.toBe(process.stdout);
          expect(harness.logger.outputStream).not.toHaveProperty("isTTY", true);
          expect(harness.logger.errorStream).toBe(process.stderr);
          const end = output.end.bind(output);
          vi.spyOn(output, "end").mockImplementation(() => {
            outputEnding.resolve();
            return end();
          });
          harness.logger.log(marker);
          if (rejectConfig) {
            throw configError;
          }
          return resolve(...args);
        });
        let flushed = false;
        let emitted = false;
        const releaseOutput = () => {
          if (flush && !flushed) {
            flushed = true;
            flush(rejectOutput ? outputError : undefined);
          }
        };
        const releaseError = () => {
          if (rejectOutput && flushed && !emitted) {
            emitted = true;
            // Deliver only this write's event; shared stdout listeners belong to other owners.
            expect(errorListener).toBeTypeOf("function");
            expect(destination.rawListeners("error")).toEqual([
              ...baselineListeners,
              errorListener,
            ]);
            errorListener?.call(destination, outputError);
          }
        };
        const running = runRealGatewayUiTests([], env);
        const observed = running.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        try {
          await withinTest(
            awaitGateBeforeSettlement(
              outputEnding.promise,
              running,
              "Config resolution ended before output cleanup",
            ),
            signal,
          );
          expect(flush).toBeTypeOf("function");
          expect(errorListener).toBeTypeOf("function");
          expect(managed).not.toHaveBeenCalled();
          expect(createWorkers).not.toHaveBeenCalled();
          expect(disposeWorkers).not.toHaveBeenCalled();
          releaseOutput();
          if (rejectOutput) {
            await withinTest(
              awaitGateBeforeSettlement(
                setImmediate(),
                running,
                "Config output settled before its destination error event",
              ),
              signal,
            );
            expect(destination.rawListeners("error")).toEqual([
              ...baselineListeners,
              errorListener,
            ]);
            expect(managed).not.toHaveBeenCalled();
            expect(createWorkers).not.toHaveBeenCalled();
          }
        } finally {
          const onAbort = () => {
            output?.destroy();
          };
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) {
            onAbort();
          }
          try {
            try {
              try {
                releaseOutput();
              } finally {
                releaseError();
              }
            } catch (error) {
              onAbort();
              throw error;
            } finally {
              await observed;
            }
            expect(destination.rawListeners("error")).toEqual(baselineListeners);
          } finally {
            signal.removeEventListener("abort", onAbort);
            if (errorListener) {
              destination.off("error", errorListener);
            }
          }
        }
        expect(sentinel).not.toHaveBeenCalled();
        const result = await observed;
        if (rejectConfig && rejectOutput && !sameError) {
          expect(result).toMatchObject({
            error: { name: "AggregateError", errors: [configError, outputError] },
          });
        } else if (rejectConfig || rejectOutput) {
          expect("error" in result ? result.error : undefined).toBe(
            rejectConfig ? configError : outputError,
          );
        } else {
          expect(result).toEqual({ value: 0 });
        }
        expect(managed).toHaveBeenCalledTimes(rejectConfig || rejectOutput ? 0 : 3);
        expect(output?.destroyed).toBe(true);
        expect(process.stdout.destroyed).toBe(false);
        expect(process.stderr.destroyed).toBe(false);
      } finally {
        destination.off("error", sentinel);
      }
      expect(destination.rawListeners("error")).toEqual(originalListeners);
    });
  },
);

it.for([false, true])(
  "rejects an unwritable diagnostic destination (errored: %s)",
  (errored, { signal }) => {
    signal.throwIfAborted();
    return diagnosticFixture.run(async () => {
      signal.throwIfAborted();
      const failure = new Error("stdout already failed");
      const destination = process.stdout;
      const listeners = destination.listeners("error");
      const write = vi.spyOn(destination, "write");
      const originals = (["writable", "errored"] as const).map(
        (key) => [key, Object.getOwnPropertyDescriptor(destination, key)] as const,
      );
      let output: Writable | undefined;
      try {
        // Inherited Node accessors are non-configurable; these own overrides must be removable.
        Object.defineProperties(destination, {
          writable: { configurable: true, value: false },
          errored: { configurable: true, value: errored ? failure : null },
        });
        const resolve = fixtures.resolveConfig.getMockImplementation()!;
        fixtures.resolveConfig.mockImplementation(async (...args) => {
          output = args[2].logger.outputStream;
          args[2].logger.log("fixture closed-output diagnostic");
          return resolve(...args);
        });
        const running = runRealGatewayUiTests([], env);
        const observed = running.then(
          () => {},
          () => {},
        );
        try {
          if (errored) {
            await withinTest(expect(running).rejects.toBe(failure), signal);
          } else {
            await withinTest(
              expect(running).rejects.toThrow("UI config stdout is not writable"),
              signal,
            );
          }
          expect(write).not.toHaveBeenCalled();
          expect(destination.listeners("error")).toEqual(listeners);
          expect(managed).not.toHaveBeenCalled();
          expect(createWorkers).not.toHaveBeenCalled();
        } finally {
          const onAbort = () => {
            output?.destroy();
          };
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) {
            onAbort();
          }
          try {
            await observed;
          } finally {
            signal.removeEventListener("abort", onAbort);
          }
        }
      } finally {
        for (const [key, descriptor] of originals) {
          if (descriptor) {
            Object.defineProperty(destination, key, descriptor);
          } else {
            Reflect.deleteProperty(destination, key);
          }
        }
      }
      for (const [key, descriptor] of originals) {
        expect(Object.getOwnPropertyDescriptor(destination, key)).toEqual(descriptor);
      }
    });
  },
);

it.each(
  [
    { name: "default absent", ambient: undefined, configured: undefined, useDefault: true },
    {
      name: "explicit production",
      ambient: "development",
      configured: "production",
      useDefault: false,
    },
    {
      name: "explicit empty",
      ambient: "production",
      configured: "",
      useDefault: false,
    },
  ].flatMap((scenario) => [false, true].map((reject) => ({ ...scenario, reject }))),
)("restores $name environment before admission (reject: $reject)", async (scenario) => {
  const ambientEnv = {
    ...env,
    NODE_ENV: scenario.ambient,
    OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: undefined,
  };
  await withEnvAsync(ambientEnv, async () => {
    const resolution = createDeferred<Awaited<ReturnType<typeof fixtures.resolveConfig>>>();
    const failure = new Error("native config resolution failed");
    const selectedEnv = { ...env, NODE_ENV: scenario.configured };
    const childNodeEnv = scenario.useDefault ? scenario.ambient : scenario.configured;
    const resolutionNodeEnv = childNodeEnv ?? "test";
    const assertRestored = () => {
      expect(process.env.NODE_ENV).toBe(scenario.ambient);
      expect(Object.hasOwn(process.env, "NODE_ENV")).toBe(scenario.ambient !== undefined);
    };
    fixtures.resolveConfig.mockImplementation(async () => {
      expect(process.env.NODE_ENV).toBe(resolutionNodeEnv);
      // Vite defaults NODE_ENV independently of its test mode.
      if (!process.env.NODE_ENV) {
        process.env.NODE_ENV = "development";
      }
      try {
        return await resolution.promise;
      } finally {
        expect(process.env.NODE_ENV).toBe(resolutionNodeEnv || "development");
      }
    });
    const createWorker = createWorkers.getMockImplementation()!;
    createWorkers.mockImplementation((...args) => {
      assertRestored();
      expect(args[0]?.NODE_ENV).toBe(childNodeEnv);
      return createWorker(...args);
    });
    managed.mockImplementation(async ({ env: childEnv }) => {
      assertRestored();
      expect(childEnv?.NODE_ENV).toBe(childNodeEnv);
      return 0;
    });
    const running = scenario.useDefault
      ? runRealGatewayUiTests([])
      : runRealGatewayUiTests([], selectedEnv);
    expect(fixtures.resolveConfig).toHaveBeenCalledTimes(1);
    expect(managed).not.toHaveBeenCalled();
    expect(createWorkers).not.toHaveBeenCalled();
    if (scenario.reject) {
      const rejected = expect(running).rejects.toBe(failure);
      resolution.reject(failure);
      await rejected;
      expect(managed).not.toHaveBeenCalled();
      expect(createWorkers).not.toHaveBeenCalled();
      expect(disposeWorkers).not.toHaveBeenCalled();
    } else {
      resolution.resolve({
        test: {
          resolvedProjects: [
            { projectConfig: { name: "ui-e2e-serial", include: ["serial.test.ts"] } },
            { projectConfig: { name: "ui-e2e-real-gateway", include: ["qualified.test.ts"] } },
          ],
        },
      });
      await expect(running).resolves.toBe(0);
      expect(managed).toHaveBeenCalledTimes(3);
      expect(createWorkers).toHaveBeenCalledTimes(1);
    }
    assertRestored();
    expect(selectedEnv.NODE_ENV).toBe(scenario.configured);
  });
});

it.each([
  { ownership: "local", parent: undefined },
  { ownership: "inherited full", parent: { directory: "/fixture/upstream" } },
  {
    ownership: "inherited runtime",
    parent: { directory: "/fixture/upstream", preset: "runtime" as const },
  },
])("reuses $ownership workers after both initial branches join", async ({ parent }) => {
  vi.mocked(getVitestWorkerDescriptor).mockReturnValue(parent);
  const serial = createDeferred<number>();
  const desktop = createDeferred<number>();
  const qualified = createDeferred<number>();
  const qualifiedStarted = createDeferred();
  const qualifiedCommandJoined = createDeferred();
  const qualifiedBorrowerJoined = createDeferred();
  borrowWorkers
    .mockResolvedValueOnce(undefined)
    .mockReturnValueOnce(qualifiedBorrowerJoined.promise);
  const receiptRead = createDeferred();
  const commandsStarted = createDeferred();
  vi.mocked(fs.readFile).mockImplementation(async () => {
    receiptRead.resolve();
    return JSON.stringify(safeReceipt);
  });
  managed.mockImplementation(async ({ args, onReady }) => {
    if (managed.mock.calls.length === 2) {
      commandsStarted.resolve();
    }
    onReady?.(new ChildProcess());
    if (project(args) === "ui-e2e-serial") {
      return serial.promise;
    }
    if (project(args) === "ui-e2e-real-gateway") {
      qualifiedStarted.resolve();
      const code = await qualified.promise;
      qualifiedCommandJoined.resolve();
      return code;
    }
    return desktop.promise;
  });
  const running = runRealGatewayUiTests([], env);
  await commandsStarted.promise;
  expect(managed).toHaveBeenCalledTimes(2);
  const [serialCall, desktopCall] = managed.mock.calls.map(([call]) => call);
  if (process.platform !== "win32") {
    expect(serialCall?.env?.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH).not.toBe(
      desktopCall?.env?.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH,
    );
  }
  expect(serialCall?.env?.OPENCLAW_VITEST_INCLUDE_FILE).toBe("/selected-tests.json");
  expect(serialCall?.args?.[serialCall.args.indexOf("--maxWorkers") + 1]).toBe("1");
  expect(desktopCall?.env).not.toHaveProperty("OPENCLAW_VITEST_INCLUDE_FILE");
  expect(desktopCall?.env).not.toHaveProperty("OPENCLAW_VITEST_POST_SHARD_INCLUDE_FILE");
  expect(desktopCall?.env?.OPENCLAW_VITEST_MAX_WORKERS).toBe("1");
  desktop.resolve(0);
  await receiptRead.promise;
  expect(managed).toHaveBeenCalledTimes(2);
  serial.resolve(0);
  await qualifiedStarted.promise;
  expect(createWorkers).toHaveBeenCalledExactlyOnceWith(expect.any(Object), parent, "runtime");
  expect(prepareWorkers).not.toHaveBeenCalled();
  expect(borrowWorkers).toHaveBeenCalledTimes(2);
  const qualifiedCall = managed.mock.calls[2]?.[0];
  const generation = parent?.directory ?? "/fixture/workers";
  const runtime = !parent || parent.preset === "runtime";
  for (const call of [serialCall, qualifiedCall]) {
    expect(call?.args?.slice(0, runtime ? 4 : 3)).toEqual([
      expect.stringMatching(/vitest-worker-bootstrap\.mts$/u),
      generation,
      ...(runtime ? ["--worker-preset=runtime"] : []),
      "scripts/run-vitest.mjs",
    ]);
    expect(call?.stdio).toEqual(["inherit", "inherit", "inherit", "ipc"]);
  }
  expect(desktopCall?.args).toEqual(["--import", "tsx", "scripts/test-desktop-resize-real.mts"]);
  expect(disposeWorkers).not.toHaveBeenCalled();
  qualified.resolve(0);
  await qualifiedCommandJoined.promise;
  await setImmediate();
  expect(disposeWorkers).not.toHaveBeenCalled();
  qualifiedBorrowerJoined.resolve();
  await expect(running).resolves.toBe(0);
  expect(disposeWorkers).toHaveBeenCalledExactlyOnceWith({ interrupted: false });
  expect(
    managed.mock.calls.every(([call]) => call.requireProcessTreeExit && call.waitForCleanupRelease),
  ).toBe(true);
});

// Native signal/tree cleanup is owned by managed-child-process.test.ts.
it.each([false, true])(
  "joins both command results on interruption (cleanup failure=%s)",
  async (failCleanup) => {
    const serial = createDeferred<number>();
    const desktop = createDeferred<number>();
    const cleanupError = new Error("cleanup failed");
    const commandsStarted = createDeferred();
    managed.mockImplementation(({ args, onReady }) => {
      if (managed.mock.calls.length === 2) {
        commandsStarted.resolve();
      }
      onReady?.(new ChildProcess());
      return project(args) === "ui-e2e-serial" ? serial.promise : desktop.promise;
    });
    const settled = vi.fn();
    const running = runRealGatewayUiTests([], env);
    const observed = running.then(settled, settled);
    await commandsStarted.promise;
    expect(managed).toHaveBeenCalledTimes(2);
    managed.mock.calls[0]![0].onSignal!("SIGTERM");
    if (failCleanup) {
      serial.reject(cleanupError);
    } else {
      serial.resolve(143);
    }
    await setImmediate();
    expect(settled).not.toHaveBeenCalled();
    expect(disposeWorkers).not.toHaveBeenCalled();
    desktop.resolve(143);
    if (failCleanup) {
      await expect(running).rejects.toMatchObject({
        name: "AggregateError",
        errors: [cleanupError],
      });
    } else {
      await expect(running).resolves.toBe(143);
    }
    await observed;
    expect(managed).toHaveBeenCalledTimes(2);
    expect(fs.readFile).not.toHaveBeenCalled();
    expect(disposeWorkers).toHaveBeenCalledExactlyOnceWith({ interrupted: true });
  },
);

it.each(["one worker", "owned cache", "no desktop"])("preserves the %s fallback", async (mode) => {
  fixtures.workers = mode === "one worker" ? 1 : 2;
  const desktopExit = createDeferred<number>();
  managed.mockImplementation(async ({ args }) =>
    args?.includes("scripts/test-desktop-resize-real.mts") ? desktopExit.promise : 0,
  );
  const selectedEnv = {
    ...env,
    ...(mode === "owned cache" ? { OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: "/owned" } : {}),
    ...(mode === "no desktop" ? { OPENCLAW_UI_E2E_RUN_DESKTOP: "false" } : {}),
  };
  const running = runRealGatewayUiTests([], selectedEnv);
  expect(managed).toHaveBeenCalledTimes(1);
  if (mode !== "no desktop") {
    expect(managed.mock.calls[0]?.[0].args).toContain("scripts/test-desktop-resize-real.mts");
    desktopExit.resolve(0);
  }
  await expect(running).resolves.toBe(0);
  expect(managed).toHaveBeenCalledTimes(mode === "no desktop" ? 1 : 2);
  expect(createWorkers).not.toHaveBeenCalled();
  expect(managed.mock.calls.every(([call]) => !call.args?.includes("--project"))).toBe(true);
  if (mode === "owned cache") {
    expect(
      managed.mock.calls.every(
        ([call]) => call.env?.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH === "/owned",
      ),
    ).toBe(true);
  }
});

it.each([
  { serial: 1, desktop: 0, qualified: 0, safe: true, later: true },
  { serial: 0, desktop: 1, qualified: 0, safe: true, later: true },
  { serial: 2, desktop: 0, qualified: 0, safe: true, later: false },
  { serial: 0, desktop: 1, qualified: 0, safe: false, later: false },
  { serial: 0, desktop: 0, qualified: 2, safe: true, later: true },
])("retains failure and admits only safely joined work (%j)", async (scenario) => {
  managed.mockImplementation(async ({ args, onReady }) => {
    onReady?.(new ChildProcess());
    return project(args) === "ui-e2e-serial"
      ? scenario.serial
      : args?.includes("scripts/test-desktop-resize-real.mts")
        ? scenario.desktop
        : scenario.qualified;
  });
  if (!scenario.safe) {
    vi.mocked(fs.readFile).mockResolvedValue('{"cleanup":{"joined":false}}');
    await expect(runRealGatewayUiTests([], env)).rejects.toThrow(
      "UI proof phase or cleanup failed",
    );
  } else {
    await expect(runRealGatewayUiTests([], env)).resolves.toBe(
      Math.max(scenario.serial, scenario.desktop, scenario.qualified),
    );
  }
  expect(managed.mock.calls.some(([call]) => project(call.args) === "ui-e2e-real-gateway")).toBe(
    scenario.later,
  );
  expect(disposeWorkers).toHaveBeenCalledExactlyOnceWith({ interrupted: false });
});

it.each(["serial", "qualified"])(
  "keeps a single %s phase on its own worker owner",
  async (phase) => {
    fixtures.serial = phase === "serial";
    fixtures.qualified = phase === "qualified";
    await expect(runRealGatewayUiTests([], env)).resolves.toBe(0);
    expect(managed).toHaveBeenCalledTimes(2);
    expect(createWorkers).not.toHaveBeenCalled();
    expect(borrowWorkers).not.toHaveBeenCalled();
    expect(disposeWorkers).not.toHaveBeenCalled();
  },
);

it("preserves a signal received while final worker disposal is joining", async () => {
  const disposalStarted = createDeferred();
  const disposalJoined = createDeferred();
  const signalListeners = process.listeners("SIGTERM");
  disposeWorkers.mockImplementation(async () => {
    disposalStarted.resolve();
    await disposalJoined.promise;
  });
  const running = runRealGatewayUiTests([], env);
  await disposalStarted.promise;
  const signalListener = process
    .listeners("SIGTERM")
    .find((entry) => !signalListeners.includes(entry));
  expect(signalListener).toBeDefined();
  signalListener?.("SIGTERM");
  disposalJoined.resolve();
  await expect(running).resolves.toBe(143);
  expect(process.listeners("SIGTERM")).toEqual(signalListeners);
});
