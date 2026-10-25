import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectCallCount } from "./run-loop-cleanup.test-support.js";
import {
  resolveGatewayShutdownBudget,
  resolveGatewayShutdownDrainBudget,
} from "./run-loop-shutdown-budget.js";

const { readFile, execUser, execSystem, execLaunchctl } = vi.hoisted(() => ({
  readFile: vi.fn(),
  execUser: vi.fn(),
  execSystem: vi.fn(),
  execLaunchctl: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({ default: { readFile } }));
vi.mock("../../daemon/systemd-exec.js", () => ({
  execSystemctlUser: execUser,
  execSystemctl: execSystem,
}));
vi.mock("../../daemon/launchd-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/launchd-exec.js")>()),
  execLaunchctl,
}));

const info = vi.fn();
const warn = vi.fn();
const resolveBudget = (
  supervisor: string | null = "external",
  refresh?: Parameters<typeof resolveGatewayShutdownBudget>[2],
) => resolveGatewayShutdownBudget(supervisor, { info, warn }, refresh);
const resolveDrain = (
  overrides: Partial<Parameters<typeof resolveGatewayShutdownDrainBudget>[0]>,
) =>
  resolveGatewayShutdownDrainBudget({
    budget: { timeoutMs: 85_000, reserveMs: 10_000, nativeStopBudget: true },
    action: "restart",
    forceRestart: false,
    restartWithoutSupervisor: false,
    acceptedAtMs: performance.now(),
    ...overrides,
  });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("process", { ...process, platform: "linux", getuid: () => 1000, env: {} });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Gateway stop deadline independent of restart ownership", () => {
  it.each([false, true])(
    "retains the native deadline when skipping a validated drain (handoff=%s)",
    (handoff) => {
      const drain = resolveDrain({
        action: "external-restart",
        forceRestart: true,
        interruptAfterDrain: handoff ? true : undefined,
        requestedRestartDrainTimeoutMs: 45_000,
      });
      if (handoff) {
        expect(drain.drainTimeoutMs).toBe(0);
        expect(drain.closeDrainTimeoutMs()).toBe(0);
      } else {
        expect(drain.drainTimeoutMs).toBeGreaterThan(44_000);
        expect(drain.closeDrainTimeoutMs()).toBeGreaterThan(44_000);
      }
      expect(drain.forceExitMs).toBe(85_000);
    },
  );
  it.each([15_000, 85_000])("bounds stop grace within the %i ms cleanup deadline", (timeoutMs) => {
    const drain = resolveDrain({
      budget: { timeoutMs, reserveMs: 10_000, nativeStopBudget: true },
      action: "stop",
    });
    expect(drain.drainTimeoutMs).toBe(Math.min(20_000, timeoutMs - 10_000));
    expect(drain.forceExitMs).toBe(timeoutMs);
  });
  it("keeps the normal budget outside a service", async () => {
    readFile.mockResolvedValue("0::/user.slice/terminal.scope\n");
    const budget = await resolveBudget(null);
    expect(budget).toMatchObject({ timeoutMs: 325_000, nativeStopBudget: false });
    expectCallCount(0, warn, execSystem, execUser);
    budget.log("startup");
    expect(info).toHaveBeenCalledWith(expect.stringContaining("Gateway stop policy"));
  });
});

describe("Gateway stop deadline follows the launchd stop that is actually running", () => {
  // A future acceptance stamp pins elapsed time to zero except in the debit cases.
  const stoppingNow = {
    previous: { timeoutMs: 325_000, nativeStopBudget: false },
    acceptedAtMs: Number.MAX_SAFE_INTEGER,
  };
  const printed = (seconds?: number, state = "SIGTERMed") => ({
    code: 0,
    stdout: `system/ai.openclaw.gateway = {\n\tstate = ${state}\n${seconds === undefined ? "" : `\texit timeout = ${seconds}\n`}\tpid = 4242\n}\n`,
    stderr: "",
    termination: "exit",
  });
  const unavailable = { code: 1, stdout: "", stderr: "permission denied", termination: "exit" };

  beforeEach(() => {
    vi.stubGlobal("process", {
      ...process,
      platform: "darwin",
      pid: 4242,
      getuid: () => 501,
      env: { XPC_SERVICE_NAME: "ai.openclaw.gateway", OPENCLAW_SUPERVISOR_MODE: "external" },
    });
  });
  afterEach(() => {
    expectCallCount(0, execSystem, execUser, readFile);
  });

  it.each([
    [5, 0, 3_750, 1_875],
    [19, 0, 14_250, 9_250],
    [20, 0, 15_000, 10_000],
    [47, 0, 42_000, 10_000],
    [20, 6_000, 9_000, 4_500],
  ] as const)(
    "allocates %is after %ims inspection",
    async (seconds, elapsed, timeoutMs, reserveMs) => {
      execLaunchctl.mockResolvedValue(printed(seconds));
      const nowMs = performance.now();
      vi.spyOn(performance, "now").mockReturnValue(nowMs);
      const budget = await resolveBudget("external", {
        previous: stoppingNow.previous,
        acceptedAtMs: nowMs - elapsed,
      });
      expect(budget).toMatchObject({ timeoutMs, reserveMs, nativeStopBudget: true });
    },
  );

  it.each([undefined, 0, 47])(
    "caps restart drain only at a finite deadline (%s seconds)",
    async (seconds) => {
      execLaunchctl.mockResolvedValue(seconds === undefined ? unavailable : printed(seconds));
      const budget = await resolveBudget("external", stoppingNow);
      expect(budget.nativeStopBudget).toBe(seconds === 47);
      const drain = resolveDrain({ budget, requestedRestartDrainTimeoutMs: 600_000 });
      if (seconds === 47) {
        expect(drain.drainTimeoutMs).toBe(32_000);
      } else {
        expect(budget.timeoutMs).toBe(325_000);
        expect(drain.drainTimeoutMs).toBeGreaterThan(590_000);
      }
      if (seconds === undefined) {
        expect(drain.restartTimeoutMs()).toBe(325_000);
        expect(warn).toHaveBeenCalledExactlyOnceWith(
          expect.stringContaining("Unable to inspect the launchd job"),
        );
      }
    },
  );

  it.each([
    ["confirmed running", printed(20, "running"), 325_000, []],
    ["failed inspection", unavailable, 15_000, ["Unable to inspect", "Retaining"]],
    ["defaulted deadline", printed(), 15_000, ["missing or invalid"]],
  ] as const)("retains the startup budget after %s", async (_name, result, timeoutMs, warnings) => {
    delete process.env.OPENCLAW_SUPERVISOR_MODE;
    execLaunchctl.mockResolvedValue(result);
    const budget = await resolveBudget("launchd", {
      previous: { timeoutMs: 15_000, nativeStopBudget: true },
      acceptedAtMs: Number.MAX_SAFE_INTEGER,
    });
    expect(budget).toMatchObject({ timeoutMs, nativeStopBudget: true });
    expect(warn.mock.calls.map(([message]) => message)).toEqual(
      warnings.map((text) => expect.stringContaining(text)),
    );
  });

  it("keeps the full policy budget for a running external job", async () => {
    execLaunchctl.mockResolvedValue(printed(5, "running"));
    const budget = await resolveBudget("external", stoppingNow);
    expect(budget).toMatchObject({ timeoutMs: 325_000, nativeStopBudget: false });
    expect(warn).not.toHaveBeenCalled();
  });
});
