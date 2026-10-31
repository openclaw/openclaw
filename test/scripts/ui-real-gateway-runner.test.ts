import { ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { getVitestWorkerDescriptor } from "../../scripts/lib/vitest-worker-descriptor.mts";
import { createVitestWorkerRun } from "../../scripts/lib/vitest-worker-run.mts";
import { runRealGatewayUiTests } from "../../scripts/test-ui-real-gateway.mts";
import { createDeferred } from "../helpers/promise.js";

const fixtures = vi.hoisted(() => ({ workers: 2, serial: true, qualified: true }));
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
afterEach(() => vi.restoreAllMocks());

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
  vi.mocked(fs.readFile).mockImplementation(async () => {
    receiptRead.resolve();
    return JSON.stringify(safeReceipt);
  });
  managed.mockImplementation(async ({ args, onReady }) => {
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
    managed.mockImplementation(({ args, onReady }) => {
      onReady?.(new ChildProcess());
      return project(args) === "ui-e2e-serial" ? serial.promise : desktop.promise;
    });
    const settled = vi.fn();
    const running = runRealGatewayUiTests([], env);
    const observed = running.then(settled, settled);
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
