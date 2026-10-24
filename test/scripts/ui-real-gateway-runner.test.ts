import * as fs from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { runRealGatewayUiTests } from "../../scripts/test-ui-real-gateway.mts";
import { createDeferred } from "../helpers/promise.js";

const fixtures = vi.hoisted(() => ({ workers: 2 }));
// mock-isolation: Keep eager environment-based config construction out of fixed coordinator project/budget fixtures.
vi.mock("../vitest/vitest.ui-e2e-prebuilt.config.ts", () => ({
  createPrebuiltUiE2eVitestConfig: () => ({
    test: {
      maxWorkers: fixtures.workers,
      projects: [
        { test: { name: "ui-e2e-serial", include: ["serial.test.ts"] } },
        { test: { name: "ui-e2e-real-gateway", include: ["parallel.test.ts"] } },
      ],
    },
  }),
}));
vi.mock("../../scripts/lib/managed-child-process.mts", async (original) => ({
  ...(await original<typeof import("../../scripts/lib/managed-child-process.mts")>()),
  runManagedCommand: vi.fn(),
}));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  readFile: vi.fn(),
}));
const managed = vi.mocked(runManagedCommand);
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
  managed.mockReset().mockResolvedValue(0);
  vi.mocked(fs.readFile).mockReset().mockResolvedValue(JSON.stringify(safeReceipt));
});
afterEach(() => vi.restoreAllMocks());

it("spends one slot per initial branch and waits for both joins before qualified fixtures", async () => {
  const serial = createDeferred<number>();
  const desktop = createDeferred<number>();
  const receiptRead = createDeferred();
  vi.mocked(fs.readFile).mockImplementation(async () => {
    receiptRead.resolve();
    return JSON.stringify(safeReceipt);
  });
  managed.mockImplementation(async ({ args }) => {
    if (project(args) === "ui-e2e-serial") {
      return serial.promise;
    }
    return args?.includes("scripts/test-desktop-resize-real.mts") ? desktop.promise : 0;
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
  await expect(running).resolves.toBe(0);
  expect(project(managed.mock.calls[2]?.[0].args)).toBe("ui-e2e-real-gateway");
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
    managed.mockImplementation(({ args }) =>
      project(args) === "ui-e2e-serial" ? serial.promise : desktop.promise,
    );
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
  { serial: 1, desktop: 0, safe: true, later: true },
  { serial: 0, desktop: 1, safe: true, later: true },
  { serial: 2, desktop: 0, safe: true, later: false },
  { serial: 0, desktop: 1, safe: false, later: false },
])("retains failure and admits only safely joined work (%j)", async (scenario) => {
  managed.mockImplementation(async ({ args }) =>
    project(args) === "ui-e2e-serial"
      ? scenario.serial
      : args?.includes("scripts/test-desktop-resize-real.mts")
        ? scenario.desktop
        : 0,
  );
  if (!scenario.safe) {
    vi.mocked(fs.readFile).mockResolvedValue('{"cleanup":{"joined":false}}');
    await expect(runRealGatewayUiTests([], env)).rejects.toThrow(
      "UI proof phase or cleanup failed",
    );
  } else {
    await expect(runRealGatewayUiTests([], env)).resolves.toBe(
      Math.max(scenario.serial, scenario.desktop),
    );
  }
  expect(managed.mock.calls.some(([call]) => project(call.args) === "ui-e2e-real-gateway")).toBe(
    scenario.later,
  );
});
