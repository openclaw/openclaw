import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectCallCount } from "./run-loop-cleanup.test-support.js";
import { resolveGatewayShutdownBudget } from "./run-loop-shutdown-budget.js";

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

beforeEach(() => {
  info.mockClear();
  warn.mockClear();
  vi.stubGlobal("process", { ...process, platform: "linux", getuid: () => 1000, env: {} });
  readFile.mockReset().mockResolvedValue("0::/system.slice/openclaw-gateway.service\n");
  execUser.mockReset().mockResolvedValue({ code: 1, stdout: "", stderr: "No user bus" });
  execSystem.mockReset().mockResolvedValue({
    code: 0,
    stdout:
      "LoadState=loaded\nTimeoutStopUSec=1min 30s\nInvocationID=own\n" +
      "User=openclaw\nType=simple\nNotifyAccess=none\nKillMode=control-group",
    stderr: "",
  });
  execLaunchctl.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Gateway stop deadline independent of restart ownership", () => {
  it("clamps an external system unit running as a service user", async () => {
    process.env.OPENCLAW_SUPERVISOR_MODE = "external";
    process.env.INVOCATION_ID = "own";
    const budget = await resolveBudget();
    budget.log("startup");
    expect(info).toHaveBeenCalledWith(
      "shutdown budget at startup: drain=75000ms shutdown=85000ms reserve=10000ms exitMargin=5000ms; source=systemd system openclaw-gateway.service TimeoutStopUSec=90000ms",
    );
    expect(budget).toMatchObject({ timeoutMs: 85_000, nativeStopBudget: true });
    expect(execSystem).toHaveBeenCalled();
    expect(execUser).not.toHaveBeenCalled();
  });

  it("warns before using a conservative fallback when inspection fails", async () => {
    process.env.INVOCATION_ID = "own";
    execSystem.mockResolvedValue({ code: 1, stdout: "", stderr: "permission denied" });
    const budget = await resolveBudget();
    expect(budget.timeoutMs).toBe(85_000);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(
        "system manager openclaw-gateway.service: systemctl show exited 1: permission denied",
      ),
    );
    expect(execUser).not.toHaveBeenCalled();
  });

  it("keeps the normal budget outside a service", async () => {
    readFile.mockResolvedValue(
      "0::/user.slice/user-1000.slice/user@1000.service/app.slice/terminal.scope\n",
    );
    const budget = await resolveBudget(null);
    expect(budget).toMatchObject({ timeoutMs: 325_000, nativeStopBudget: false });
    expectCallCount(0, warn, execSystem, execUser);
  });
});

describe("Gateway stop deadline follows the launchd stop that is actually running", () => {
  // A future acceptance stamp pins elapsed time to zero except in the debit cases.
  const stoppingNow = {
    previous: { timeoutMs: 325_000, nativeStopBudget: false },
    acceptedAtMs: Number.MAX_SAFE_INTEGER,
  };
  const printed = (seconds?: number, state = "SIGTERMed", extra = "") => ({
    code: 0,
    stdout: `system/ai.openclaw.gateway = {\n\tstate = ${state}\n\n${extra}${seconds === undefined ? "" : `\texit timeout = ${seconds}\n`}\tpid = 4242\n\tresource coalition = {\n\t\tstate = active\n\t}\n}\n`,
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
    [5, 0, 3_750, 1_875, 1_875, 1_250],
    [19, 0, 14_250, 9_250, 5_000, 4_750],
    [20, 0, 15_000, 10_000, 5_000, 5_000],
    [47, 0, 42_000, 10_000, 32_000, 5_000],
    [20, 6_000, 9_000, 4_500, 4_500, 5_000],
  ] as const)(
    "allocates a %i second deadline after %i ms of inspection",
    async (seconds, elapsed, timeoutMs, reserveMs, drainMs, exitMarginMs) => {
      execLaunchctl.mockResolvedValue(printed(seconds, "SIGTERMed", "\tminimum runtime = 10\n"));
      const nowMs = performance.now();
      vi.spyOn(performance, "now").mockReturnValue(nowMs);
      const budget = await resolveBudget("external", {
        previous: stoppingNow.previous,
        acceptedAtMs: nowMs - elapsed,
      });
      expect(budget).toMatchObject({ timeoutMs, reserveMs, nativeStopBudget: true });
      expect(budget.timeoutMs - budget.reserveMs).toBe(drainMs);
      if (!elapsed) {
        budget.log("shutdown");
        expect(info).toHaveBeenCalledWith(
          `shutdown budget at shutdown: drain=${drainMs}ms shutdown=${timeoutMs}ms reserve=${reserveMs}ms exitMargin=${exitMarginMs}ms; source=launchd system/ai.openclaw.gateway exit timeout=${seconds * 1_000}ms`,
        );
      }
    },
  );

  it.each([
    { supervisor: "external", seconds: undefined },
    { supervisor: "external", seconds: 0 },
    { supervisor: "external", seconds: 47 },
  ])(
    "recognizes a finite native shutdown deadline ($supervisor/$seconds)",
    async ({ supervisor, seconds }) => {
      execLaunchctl.mockResolvedValue(seconds === undefined ? unavailable : printed(seconds));
      const budget = await resolveBudget(supervisor, stoppingNow);
      expect(budget.nativeStopBudget).toBe(seconds === 47);
      if (seconds === 47) {
        expect(budget.timeoutMs).toBe(42_000);
      } else {
        expect(budget.timeoutMs).toBe(325_000);
      }
      if (seconds === undefined) {
        expect(warn).toHaveBeenCalledExactlyOnceWith(
          expect.stringContaining("Unable to inspect the launchd job"),
        );
      }
    },
  );

  const inspectWarning = expect.stringContaining("Unable to inspect the launchd job");
  const retainWarning =
    "Retaining the startup shutdown budget of 15000ms because the current supervisor stop timeout could not be confirmed.";
  const missingWarning = expect.stringContaining("its exit timeout is missing or invalid");
  it.each([
    ["confirmed running", printed(20, "running"), 325_000, []],
    ["failed inspection", unavailable, 15_000, [inspectWarning, retainWarning]],
    ["defaulted deadline", printed(), 15_000, [missingWarning]],
  ] as const)(
    "retains the launchd startup budget only after %s",
    async (_name, result, timeoutMs, warnings) => {
      delete process.env.OPENCLAW_SUPERVISOR_MODE;
      execLaunchctl.mockResolvedValue(result);
      const budget = await resolveBudget("launchd", {
        previous: { timeoutMs: 15_000, nativeStopBudget: true },
        acceptedAtMs: Number.MAX_SAFE_INTEGER,
      });
      expect(budget).toMatchObject({ timeoutMs, nativeStopBudget: true });
      expect(warn.mock.calls).toEqual(warnings.map((message) => [message]));
    },
  );

  it.each(["startup", "unmanaged stop", "running job"])(
    "keeps the full budget for %s",
    async (phase) => {
      if (phase === "unmanaged stop") {
        process.env = {};
      }
      if (phase === "running job") {
        execLaunchctl.mockResolvedValue(printed(5, "running"));
      }
      const budget = await resolveBudget(
        phase === "unmanaged stop" ? null : "external",
        phase === "startup" ? undefined : stoppingNow,
      );
      if (phase !== "running job") {
        expectCallCount(0, execLaunchctl);
      }
      expectCallCount(0, warn);
      expect(budget).toMatchObject({ timeoutMs: 325_000, nativeStopBudget: false });
      const logPhase = phase === "running job" ? "shutdown" : "startup";
      budget.log(logPhase);
      expect(info).toHaveBeenCalledWith(
        `shutdown budget at ${logPhase}: drain=315000ms shutdown=325000ms reserve=10000ms exitMargin=5000ms; source=Gateway stop policy=330000ms`,
      );
    },
  );
});
