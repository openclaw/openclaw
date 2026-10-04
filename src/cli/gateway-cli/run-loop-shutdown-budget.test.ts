import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_SHUTDOWN_RESERVE_MS } from "../../infra/gateway-shutdown-budget.js";
import {
  resolveGatewayRequestShutdownBudget,
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

beforeEach(() => {
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
    const info = vi.fn();
    const budget = await resolveGatewayShutdownBudget("external", { info, warn: vi.fn() });
    budget.log("startup");
    expect(info).toHaveBeenCalledWith(
      "shutdown budget at startup: drain=75000ms shutdown=85000ms reserve=10000ms exitMargin=5000ms; source=systemd system openclaw-gateway.service TimeoutStopUSec=90000ms",
    );
    expect(budget.timeoutMs).toBe(85_000);
    expect(budget.nativeStopBudget).toBe(true);
    expect(execSystem).toHaveBeenCalled();
    expect(execUser).not.toHaveBeenCalled();
  });

  it("warns before using a conservative fallback when inspection fails", async () => {
    process.env.INVOCATION_ID = "own";
    execSystem.mockResolvedValue({ code: 1, stdout: "", stderr: "permission denied" });
    const warn = vi.fn();
    const budget = await resolveGatewayShutdownBudget("external", { info: vi.fn(), warn });
    expect(budget.timeoutMs).toBe(85_000);
    expect(budget.observedTimeoutMs).toBeUndefined();
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
    const warn = vi.fn();
    const budget = await resolveGatewayShutdownBudget(null, { info: vi.fn(), warn });
    expect(budget.timeoutMs).toBe(325_000);
    expect(budget.nativeStopBudget).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect(execSystem).not.toHaveBeenCalled();
    expect(execUser).not.toHaveBeenCalled();
  });
});

describe("Gateway stop deadline follows the launchd stop that is actually running", () => {
  // A future acceptance stamp pins elapsed time to zero except in the debit cases.
  const stoppingNow = {
    previous: { timeoutMs: 325_000, nativeStopBudget: false },
    acceptedAtMs: Number.MAX_SAFE_INTEGER,
  };
  const printed = (state: string, fields: string) => ({
    code: 0,
    stdout: `system/ai.openclaw.gateway = {\n\tstate = ${state}\n\n${fields}\tresource coalition = {\n\t\tstate = active\n\t}\n}\n`,
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
    expect(execSystem).not.toHaveBeenCalled();
    expect(execUser).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it.each([
    { state: "SIGTERMed", seconds: 90 },
    { state: "SIGTERMed", seconds: 20 },
    { state: "running", seconds: undefined },
    { state: "SIGTERMed", seconds: undefined },
    { state: "SIGTERMed", seconds: "invalid" },
  ])(
    "does not mistake launchd fallback policy for an observed deadline ($state/$seconds)",
    async ({ state, seconds }) => {
      const logger = { info: vi.fn(), warn: vi.fn() };
      const startupBudget = await resolveGatewayShutdownBudget("launchd", logger);
      expect(execLaunchctl).not.toHaveBeenCalled();
      execLaunchctl.mockResolvedValue(
        seconds === undefined
          ? printed(state, "\tpid = 4242\n")
          : printed(state, `\texit timeout = ${seconds}\n\tpid = 4242\n`),
      );
      vi.spyOn(performance, "now").mockReturnValue(1_000);
      const onDeadline = vi.fn();
      const budget = await resolveGatewayRequestShutdownBudget({
        supervisor: "launchd",
        logger,
        startupBudget,
        acceptedAtMs: 1_000,
        stopTimeoutMs: 60_000,
        onDeadline,
      });
      expect(onDeadline.mock.calls[0]?.[0].timeoutMs).toBe(60_000);
      expect(budget.timeoutMs).toBe(seconds === 20 ? 15_000 : 60_000);
    },
  );

  it.each([undefined, "invalid"])(
    "retains a known launcher deadline when the job timeout is %s",
    async (seconds) => {
      process.env.OPENCLAW_LAUNCHD_LABEL = "ai.openclaw.gateway";
      process.env.OPENCLAW_NODE_UPDATE_RESPAWNED = "1";
      vi.stubGlobal("process", {
        ...process,
        ppid: 4241,
        argv: ["node", "openclaw", "gateway", "run"],
      });
      const logger = { info: vi.fn(), warn: vi.fn() };
      const startupBudget = await resolveGatewayShutdownBudget("launchd", logger);
      execLaunchctl.mockResolvedValue(
        printed(
          "SIGTERMed",
          (seconds === undefined ? "" : `\texit timeout = ${seconds}\n`) + "\tpid = 4241\n",
        ),
      );
      vi.spyOn(performance, "now").mockReturnValue(1_000);
      const budget = await resolveGatewayRequestShutdownBudget({
        supervisor: "launchd",
        logger,
        startupBudget,
        acceptedAtMs: 1_000,
        stopTimeoutMs: 60_000,
        onDeadline: vi.fn(),
      });
      expect(budget.timeoutMs).toBe(14_250);
      const unset = await resolveGatewayShutdownBudget("launchd", logger, stoppingNow);
      expect(unset.timeoutMs).toBe(15_000);
    },
  );

  it("keeps the full drain when launchd did not initiate the stop", async () => {
    execLaunchctl.mockResolvedValue(printed("running", "\texit timeout = 5\n\tpid = 4242\n"));
    const info = vi.fn();
    const budget = await resolveGatewayShutdownBudget(
      "external",
      { info, warn: vi.fn() },
      stoppingNow,
    );
    budget.log("shutdown");
    expect(info).toHaveBeenCalledWith(
      "shutdown budget at shutdown: drain=315000ms shutdown=325000ms reserve=10000ms exitMargin=5000ms; source=Gateway stop policy=330000ms",
    );
    expect(budget.timeoutMs).toBe(325_000);
    expect(budget.nativeStopBudget).toBe(false);
  });

  it.each([
    { seconds: 5, timeoutMs: 3_750, reserveMs: 1_875, drainMs: 1_875, exitMarginMs: 1_250 },
    { seconds: 19, timeoutMs: 14_250, reserveMs: 9_250, drainMs: 5_000, exitMarginMs: 4_750 },
    { seconds: 20, timeoutMs: 15_000, reserveMs: 10_000, drainMs: 5_000, exitMarginMs: 5_000 },
    { seconds: 47, timeoutMs: 42_000, reserveMs: 10_000, drainMs: 32_000, exitMarginMs: 5_000 },
  ])(
    "allocates the drain and reserve for a $seconds second deadline",
    async ({ seconds, timeoutMs, reserveMs, drainMs, exitMarginMs }) => {
      execLaunchctl.mockResolvedValue(
        printed("SIGTERMed", `\tminimum runtime = 10\n\texit timeout = ${seconds}\n\tpid = 4242\n`),
      );
      const info = vi.fn();
      const budget = await resolveGatewayShutdownBudget(
        "external",
        { info, warn: vi.fn() },
        stoppingNow,
      );
      budget.log("shutdown");
      expect(budget.timeoutMs).toBe(timeoutMs);
      expect(budget.reserveMs).toBe(reserveMs);
      expect(budget.timeoutMs - budget.reserveMs).toBe(drainMs);
      expect(budget.nativeStopBudget).toBe(true);
      expect(info).toHaveBeenCalledWith(
        `shutdown budget at shutdown: drain=${drainMs}ms shutdown=${timeoutMs}ms reserve=${reserveMs}ms exitMargin=${exitMarginMs}ms; source=launchd system/ai.openclaw.gateway exit timeout=${seconds * 1_000}ms`,
      );
    },
  );

  it.each([
    { elapsed: 13, timeoutMs: 14_987, reserveMs: 9_987, drainMs: 5_000 },
    { elapsed: 6_000, timeoutMs: 9_000, reserveMs: 4_500, drainMs: 4_500 },
  ])(
    "debits $elapsed ms of inspection time before allocating the reserve",
    async ({ elapsed, timeoutMs, reserveMs, drainMs }) => {
      execLaunchctl.mockResolvedValue(printed("SIGTERMed", "\texit timeout = 20\n\tpid = 4242\n"));
      const nowMs = performance.now();
      vi.spyOn(performance, "now").mockReturnValue(nowMs);
      const budget = await resolveGatewayShutdownBudget(
        "external",
        { info: vi.fn(), warn: vi.fn() },
        {
          previous: stoppingNow.previous,
          acceptedAtMs: nowMs - elapsed,
        },
      );
      expect(budget.timeoutMs).toBe(timeoutMs);
      expect(budget.reserveMs).toBe(reserveMs);
      expect(budget.timeoutMs - budget.reserveMs).toBe(drainMs);
      if (elapsed === 6_000) {
        expect(budget.reserveMs).not.toBe(GATEWAY_SHUTDOWN_RESERVE_MS - elapsed);
      }
    },
  );

  it.each([
    { supervisor: "external", seconds: undefined },
    { supervisor: "external", seconds: 0 },
    { supervisor: "launchd", seconds: 0 },
    { supervisor: "external", seconds: 47 },
  ])(
    "caps a requested restart drain only at a confirmed finite deadline ($supervisor/$seconds)",
    async ({ supervisor, seconds }) => {
      execLaunchctl.mockResolvedValue(
        seconds === undefined
          ? unavailable
          : printed("SIGTERMed", `\texit timeout = ${seconds}\n\tpid = 4242\n`),
      );
      const warn = vi.fn();
      const budget = await resolveGatewayShutdownBudget(
        supervisor,
        { info: vi.fn(), warn },
        stoppingNow,
      );
      expect(budget.nativeStopBudget).toBe(seconds === 47);
      const drain = resolveGatewayShutdownDrainBudget({
        budget,
        action: "restart",
        forceRestart: false,
        restartWithoutSupervisor: false,
        acceptedAtMs: performance.now(),
        requestedRestartDrainTimeoutMs: 600_000,
      });
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
    {
      name: "confirmed running",
      result: printed("running", "\texit timeout = 20\n\tpid = 4242\n"),
      warnings: [],
    },
    {
      name: "failed inspection",
      result: unavailable,
      warnings: [
        expect.stringContaining("Unable to inspect the launchd job"),
        "Retaining the startup shutdown budget of 15000ms because the current supervisor stop timeout could not be confirmed.",
      ],
    },
    {
      name: "defaulted deadline",
      result: printed("SIGTERMed", "\tpid = 4242\n"),
      warnings: [expect.stringContaining("its exit timeout is missing or invalid")],
    },
  ])("retains the launchd startup budget only after $name", async ({ result, warnings }) => {
    delete process.env.OPENCLAW_SUPERVISOR_MODE;
    execLaunchctl.mockResolvedValue(result);
    const warn = vi.fn();
    const budget = await resolveGatewayShutdownBudget(
      "launchd",
      { info: vi.fn(), warn },
      {
        previous: { timeoutMs: 15_000, nativeStopBudget: true },
        acceptedAtMs: Number.MAX_SAFE_INTEGER,
      },
    );
    expect(budget.timeoutMs).toBe(15_000);
    expect(budget.nativeStopBudget).toBe(true);
    expect(warn.mock.calls).toEqual(warnings.map((message) => [message]));
  });

  it.each(["startup", "unmanaged stop"])(
    "does not inspect a launchd job during %s",
    async (phase) => {
      if (phase === "unmanaged stop") {
        process.env = {};
      }
      const info = vi.fn();
      const warn = vi.fn();
      const budget = await resolveGatewayShutdownBudget(
        phase === "startup" ? "external" : null,
        { info, warn },
        phase === "startup" ? undefined : stoppingNow,
      );
      expect(execLaunchctl).not.toHaveBeenCalled();
      expect(budget.timeoutMs).toBe(325_000);
      expect(budget.nativeStopBudget).toBe(false);
      expect(warn).not.toHaveBeenCalled();
      budget.log("startup");
      expect(info).toHaveBeenCalledWith(
        "shutdown budget at startup: drain=315000ms shutdown=325000ms reserve=10000ms exitMargin=5000ms; source=Gateway stop policy=330000ms",
      );
    },
  );
});
