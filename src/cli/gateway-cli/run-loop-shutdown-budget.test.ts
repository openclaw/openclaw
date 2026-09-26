import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_SHUTDOWN_RESERVE_MS,
  GATEWAY_SUPERVISOR_EXIT_MARGIN_MS,
} from "../../infra/gateway-shutdown-budget.js";
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
afterEach(() => vi.unstubAllGlobals());

describe("Gateway stop deadline independent of restart ownership", () => {
  it.each(["own", undefined])(
    "clamps an external system unit running as a service user (invocation=%s)",
    async (invocation) => {
      process.env.OPENCLAW_SUPERVISOR_MODE = "external";
      if (invocation) {
        process.env.INVOCATION_ID = invocation;
      }
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
    },
  );

  it.each([
    {
      result: { code: 1, stdout: "", stderr: "permission denied" },
      reason: "systemctl show exited 1: permission denied",
    },
    {
      result: { code: 0, stdout: "LoadState=not-found", stderr: "" },
      reason: "LoadState=not-found",
    },
    {
      result: {
        code: 0,
        stdout: "LoadState=loaded\nTimeoutStopUSec=10min\nInvocationID=other",
        stderr: "",
      },
      reason: "InvocationID does not match",
    },
    {
      result: { code: 0, stdout: "LoadState=loaded\nInvocationID=own", stderr: "" },
      reason: "TimeoutStopUSec is missing or invalid",
    },
  ])("warns before using a conservative fallback: $reason", async ({ result, reason }) => {
    process.env.INVOCATION_ID = "own";
    execSystem.mockResolvedValue(result);
    const warn = vi.fn();
    const budget = await resolveGatewayShutdownBudget("external", { info: vi.fn(), warn });
    expect(budget.timeoutMs).toBe(85_000);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(`system manager openclaw-gateway.service: ${reason}`),
    );
    expect(execUser).not.toHaveBeenCalled();
  });

  it.each([
    "0::/\n",
    "0::/user.slice/user-1000.slice/user@1000.service/app.slice/terminal.scope\n",
  ])("keeps the normal budget outside a service (%s)", async (membership) => {
    readFile.mockResolvedValue(membership);
    const warn = vi.fn();
    const budget = await resolveGatewayShutdownBudget(null, { info: vi.fn(), warn });
    expect(budget.timeoutMs).toBe(325_000);
    expect(budget.nativeStopBudget).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect(execSystem).not.toHaveBeenCalled();
    expect(execUser).not.toHaveBeenCalled();
  });

  // The systemd coverage above only pins TimeoutStopUSec at 90 seconds and 10 minutes,
  // both comfortably above the 20 second threshold. This mirrors the darwin exit-timeout
  // table's sub-20-second cases against a systemd stub: a unit deadline in this band
  // gives up part of a reserve a flat subtraction would have funded in full, rather than
  // draining for zero milliseconds as that flat subtraction did.
  it.each([
    { seconds: 19, timeoutMs: 14_250, reserveMs: 9_250, drainMs: 5_000, fixedDrainMs: 4_000 },
    { seconds: 16, timeoutMs: 12_000, reserveMs: 7_000, drainMs: 5_000, fixedDrainMs: 1_000 },
    { seconds: 15, timeoutMs: 11_250, reserveMs: 6_250, drainMs: 5_000, fixedDrainMs: 0 },
    { seconds: 10, timeoutMs: 7_500, reserveMs: 3_750, drainMs: 3_750, fixedDrainMs: 0 },
  ])(
    "keeps a drain a $seconds second systemd TimeoutStopUSec previously spent on overhead",
    async ({ seconds, timeoutMs, reserveMs, drainMs, fixedDrainMs }) => {
      process.env.OPENCLAW_SUPERVISOR_MODE = "external";
      execSystem.mockResolvedValue({
        code: 0,
        stdout: `LoadState=loaded\nTimeoutStopUSec=${seconds}s\nInvocationID=own`,
        stderr: "",
      });
      const budget = await resolveGatewayShutdownBudget("external", {
        info: vi.fn(),
        warn: vi.fn(),
      });
      expect(budget.timeoutMs).toBe(timeoutMs);
      expect(budget.reserveMs).toBe(reserveMs);
      expect(budget.timeoutMs - budget.reserveMs).toBe(drainMs);
      // What a flat, unshared subtraction would have left active work at the same deadline.
      expect(
        Math.max(
          0,
          seconds * 1_000 - GATEWAY_SUPERVISOR_EXIT_MARGIN_MS - GATEWAY_SHUTDOWN_RESERVE_MS,
        ),
      ).toBe(fixedDrainMs);
      expect(budget.reserveMs).toBeGreaterThanOrEqual(Math.floor(timeoutMs / 2));
    },
  );
});

describe("Gateway stop deadline follows the launchd stop that is actually running", () => {
  // A stop that is under way. `previous` is the startup budget a darwin Gateway
  // resolves before any stop exists, which is the platform-neutral policy.
  // The budget subtracts `performance.now() - acceptedAtMs` and floors it at
  // zero, so an acceptance stamped ahead of the clock records exactly no elapsed
  // time and keeps the asserted numbers exact instead of off by a stray
  // millisecond.
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

  beforeEach(() => {
    vi.stubGlobal("process", {
      ...process,
      platform: "darwin",
      pid: 4242,
      getuid: () => 501,
      env: {},
    });
    process.env.XPC_SERVICE_NAME = "ai.openclaw.gateway";
    process.env.OPENCLAW_SUPERVISOR_MODE = "external";
  });

  // THE REGRESSION GUARD. The linked report is an externally delivered SIGTERM
  // under a five second job, where launchd never starts its clock and the drain ran
  // its full 315 seconds. Measured on the reporting host, it then hit its own
  // timeout with work still active rather than finishing early, so the drain was
  // being used. Adopting the job deadline there would hand that same supported
  // setup a zero drain and cut that work off at once.
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

  // A deadline this short cannot fund the fixed 5s margin and 10s reserve, and
  // subtracting them outright left the job's whole 5 seconds spent on overhead with
  // nothing to drain. Each allowance is capped at a share of what it is carved from,
  // so the short job keeps a proportional drain that still fits inside the deadline.
  it("keeps a proportional drain when the job's exit timeout cannot fund the fixed allowances", async () => {
    execLaunchctl.mockResolvedValue(
      printed("SIGTERMed", "\tminimum runtime = 10\n\texit timeout = 5\n\tpid = 4242\n"),
    );
    const info = vi.fn();
    const budget = await resolveGatewayShutdownBudget(
      "external",
      { info, warn: vi.fn() },
      stoppingNow,
    );
    budget.log("shutdown");
    expect(info).toHaveBeenCalledWith(
      "shutdown budget at shutdown: drain=1875ms shutdown=3750ms reserve=1875ms exitMargin=1250ms; source=launchd system/ai.openclaw.gateway exit timeout=5000ms",
    );
    expect(budget.timeoutMs).toBe(3_750);
    expect(budget.reserveMs).toBe(1_875);
    expect(budget.nativeStopBudget).toBe(true);
  });

  // Drain must never be starved to zero by the allowances: every positive deadline
  // leaves active work some time, and a longer deadline never yields less of it.
  it.each([1, 2, 5, 10, 15, 20, 25, 47, 60])(
    "leaves a positive drain for a %s second exit timeout",
    async (seconds) => {
      execLaunchctl.mockResolvedValue(
        printed("SIGTERMed", `\texit timeout = ${seconds}\n\tpid = 4242\n`),
      );
      const budget = await resolveGatewayShutdownBudget(
        "external",
        { info: vi.fn(), warn: vi.fn() },
        stoppingNow,
      );
      expect(budget.timeoutMs - budget.reserveMs).toBeGreaterThan(0);
      expect(budget.timeoutMs).toBeLessThanOrEqual(seconds * 1_000);
    },
  );

  it.each([
    { seconds: 20, timeoutMs: 15_000, reserveMs: 10_000, drainMs: 5_000, exitMarginMs: 5_000 },
    { seconds: 47, timeoutMs: 42_000, reserveMs: 10_000, drainMs: 32_000, exitMarginMs: 5_000 },
    { seconds: 55, timeoutMs: 50_000, reserveMs: 10_000, drainMs: 40_000, exitMarginMs: 5_000 },
  ])(
    "derives the budget from a $seconds second exit timeout",
    async ({ seconds, timeoutMs, reserveMs, drainMs, exitMarginMs }) => {
      execLaunchctl.mockResolvedValue(
        printed("SIGTERMed", `\texit timeout = ${seconds}\n\tpid = 4242\n`),
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
      expect(info).toHaveBeenCalledWith(
        `shutdown budget at shutdown: drain=${drainMs}ms shutdown=${timeoutMs}ms reserve=${reserveMs}ms exitMargin=${exitMarginMs}ms; source=launchd system/ai.openclaw.gateway exit timeout=${seconds * 1_000}ms`,
      );
    },
  );

  // Every case above pins `acceptedAtMs` to `Number.MAX_SAFE_INTEGER`, which floors
  // elapsed at zero and proves nothing about a real, nonzero debit. `performance.now`
  // is not faked anywhere in this file, so this pins it directly rather than trusting
  // the wall clock to land on a specific millisecond by chance: the reserve gives up
  // exactly that observed 13ms debit and the 5 second drain floor still funds in full.
  it("debits the reserve by a real elapsed delay, leaving the drain floor untouched", async () => {
    execLaunchctl.mockResolvedValue(printed("SIGTERMed", "\texit timeout = 20\n\tpid = 4242\n"));
    const nowMs = performance.now();
    const clock = vi.spyOn(performance, "now").mockReturnValue(nowMs);
    try {
      const budget = await resolveGatewayShutdownBudget(
        "external",
        { info: vi.fn(), warn: vi.fn() },
        { previous: stoppingNow.previous, acceptedAtMs: nowMs - 13 },
      );
      expect(budget.timeoutMs).toBe(14_987);
      expect(budget.reserveMs).toBe(9_987);
      expect(budget.timeoutMs - budget.reserveMs).toBe(5_000);
    } finally {
      clock.mockRestore();
    }
  });

  // The case above only covers a debit small enough that the reserve pays it alone. The
  // probe can cost far more than 13ms: it is up to three `launchctl print` calls at a
  // 2 second timeout each. Past a 5 second debit the drain floor is share-bounded too,
  // so the claim that a 20 second deadline keeps its old allocation less the debit stops
  // holding and both allowances converge on half the remainder. Pinning that boundary
  // keeps the documented threshold honest instead of reasoned.
  it("converges the reserve and the drain once the elapsed debit passes the floor", async () => {
    execLaunchctl.mockResolvedValue(printed("SIGTERMed", "\texit timeout = 20\n\tpid = 4242\n"));
    const nowMs = performance.now();
    const clock = vi.spyOn(performance, "now").mockReturnValue(nowMs);
    try {
      const budget = await resolveGatewayShutdownBudget(
        "external",
        { info: vi.fn(), warn: vi.fn() },
        { previous: stoppingNow.previous, acceptedAtMs: nowMs - 6_000 },
      );
      expect(budget.timeoutMs).toBe(9_000);
      expect(budget.reserveMs).toBe(4_500);
      expect(budget.timeoutMs - budget.reserveMs).toBe(4_500);
      // Not the old allocation less the debit: that would have left the reserve at 4000.
      expect(budget.reserveMs).not.toBe(GATEWAY_SHUTDOWN_RESERVE_MS - 6_000);
    } finally {
      clock.mockRestore();
    }
  });

  // The allowances are only ever capped to keep a drain, never to reallocate a deadline
  // that already worked. A deadline able to fund the 10s reserve alongside the 5s drain
  // the 20s template yields needs 15s of shutdown budget, which every deadline from 20s
  // up has, so all of them must resolve exactly what subtracting the fixed allowances
  // outright resolved. Asserting against that arithmetic rather than against literals is
  // what makes this a regression test: capping the reserve at a share of the budget, as
  // an earlier revision did, drops a 20s job's reserve to 7500ms and fails here.
  it.each([20, 21, 25, 30, 47, 55, 60])(
    "allocates a %s second exit timeout exactly as the fixed allowances did",
    async (seconds) => {
      execLaunchctl.mockResolvedValue(
        printed("SIGTERMed", `\texit timeout = ${seconds}\n\tpid = 4242\n`),
      );
      const budget = await resolveGatewayShutdownBudget(
        "external",
        { info: vi.fn(), warn: vi.fn() },
        stoppingNow,
      );
      const fixedTimeoutMs = seconds * 1_000 - GATEWAY_SUPERVISOR_EXIT_MARGIN_MS;
      expect(budget.timeoutMs).toBe(fixedTimeoutMs);
      expect(budget.reserveMs).toBe(GATEWAY_SHUTDOWN_RESERVE_MS);
      expect(budget.timeoutMs - budget.reserveMs).toBe(
        fixedTimeoutMs - GATEWAY_SHUTDOWN_RESERVE_MS,
      );
    },
  );

  // Under 20 seconds the budget cannot fund both allowances, so one has to give. The
  // fixed subtraction gave up the drain: 15 seconds and below drained for 0ms, and the
  // four deadlines between left active work under 5 seconds. These pin what is given up
  // instead, and that the reserve never falls below half the budget doing it. No shipped
  // template or platform default lands here: the LaunchAgent template and launchd's own
  // default are both 20 seconds, and systemd's default stop timeout is 90.
  it.each([
    { seconds: 19, timeoutMs: 14_250, reserveMs: 9_250, drainMs: 5_000, fixedDrainMs: 4_000 },
    { seconds: 16, timeoutMs: 12_000, reserveMs: 7_000, drainMs: 5_000, fixedDrainMs: 1_000 },
    { seconds: 15, timeoutMs: 11_250, reserveMs: 6_250, drainMs: 5_000, fixedDrainMs: 0 },
    { seconds: 10, timeoutMs: 7_500, reserveMs: 3_750, drainMs: 3_750, fixedDrainMs: 0 },
  ])(
    "keeps a drain a $seconds second exit timeout previously spent on overhead",
    async ({ seconds, timeoutMs, reserveMs, drainMs, fixedDrainMs }) => {
      execLaunchctl.mockResolvedValue(
        printed("SIGTERMed", `\texit timeout = ${seconds}\n\tpid = 4242\n`),
      );
      const budget = await resolveGatewayShutdownBudget(
        "external",
        { info: vi.fn(), warn: vi.fn() },
        stoppingNow,
      );
      expect(budget.timeoutMs).toBe(timeoutMs);
      expect(budget.reserveMs).toBe(reserveMs);
      expect(budget.timeoutMs - budget.reserveMs).toBe(drainMs);
      // What the fixed subtraction left active work at the same deadline.
      expect(
        Math.max(
          0,
          seconds * 1_000 - GATEWAY_SUPERVISOR_EXIT_MARGIN_MS - GATEWAY_SHUTDOWN_RESERVE_MS,
        ),
      ).toBe(fixedDrainMs);
      expect(budget.reserveMs).toBeGreaterThanOrEqual(Math.floor(timeoutMs / 2));
    },
  );

  // Failing to inspect the job establishes nothing, so shortening the drain here
  // would cut work that no launchd deadline was bounding.
  it("warns and keeps the platform-neutral policy when the job cannot be inspected", async () => {
    execLaunchctl.mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "permission denied",
      termination: "exit",
    });
    const warn = vi.fn();
    const budget = await resolveGatewayShutdownBudget(
      "external",
      { info: vi.fn(), warn },
      stoppingNow,
    );
    expect(budget.timeoutMs).toBe(325_000);
    // The number alone is not the contract. A failed probe confirmed no launchd
    // deadline, so this must not be classified as a native stop budget either:
    // that flag is what caps a restart drain and arms a forced exit.
    expect(budget.nativeStopBudget).toBe(false);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("Unable to inspect the launchd job"),
    );
  });

  // The flag is only worth asserting because of what it does downstream, so drive
  // the real consumer. An operator restart that asked to drain for ten minutes
  // keeps that request when no launchd deadline was ever confirmed.
  it("leaves a longer requested restart drain uncapped when the job cannot be inspected", async () => {
    execLaunchctl.mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "permission denied",
      termination: "exit",
    });
    const budget = await resolveGatewayShutdownBudget(
      "external",
      { info: vi.fn(), warn: vi.fn() },
      stoppingNow,
    );
    expect(budget.nativeStopBudget).toBe(false);
    const drain = resolveGatewayShutdownDrainBudget({
      budget,
      isRestart: true,
      forceRestart: false,
      restartWithoutSupervisor: false,
      acceptedAtMs: performance.now(),
      requestedRestartDrainTimeoutMs: 600_000,
    });
    // Only elapsed time comes off the request; no supervisor ceiling applies.
    expect(drain.drainTimeoutMs).toBeGreaterThan(590_000);
    expect(drain.restartTimeoutMs()).toBe(325_000);
  });

  // The same consumer, with a deadline that WAS confirmed, still gets capped.
  // Without this pair the test above would also pass if the launchd read were
  // deleted outright.
  it("caps that same restart drain at a confirmed job deadline", async () => {
    execLaunchctl.mockResolvedValue(printed("SIGTERMed", "\texit timeout = 47\n\tpid = 4242\n"));
    const budget = await resolveGatewayShutdownBudget(
      "external",
      { info: vi.fn(), warn: vi.fn() },
      stoppingNow,
    );
    expect(budget.nativeStopBudget).toBe(true);
    const drain = resolveGatewayShutdownDrainBudget({
      budget,
      isRestart: true,
      forceRestart: false,
      restartWithoutSupervisor: false,
      acceptedAtMs: performance.now(),
      requestedRestartDrainTimeoutMs: 600_000,
    });
    // 47s job - 5s exit margin = 42000ms shutdown, less the 10000ms reserve.
    expect(drain.drainTimeoutMs).toBe(32_000);
  });

  // A launchd-OWNED Gateway, rather than an externally supervised one. Its startup
  // budget is already native, so this is the configuration where the retained-budget
  // safety net can fire. `previous` is what a 20 second template job resolves.
  const launchdOwnedStop = {
    previous: { timeoutMs: 15_000, nativeStopBudget: true },
    acceptedAtMs: Number.MAX_SAFE_INTEGER,
  };

  // An in-process restart signals the Gateway without launchd running the stop, so
  // the job still prints `running`. That is a confirmed answer, not a failed probe,
  // and claiming the deadline "could not be confirmed" there would be false on every
  // in-process restart of a default macOS install.
  it("does not claim an unconfirmed timeout when launchd is confirmed not to be stopping", async () => {
    delete process.env.OPENCLAW_SUPERVISOR_MODE;
    execLaunchctl.mockResolvedValue(printed("running", "\texit timeout = 20\n\tpid = 4242\n"));
    const warn = vi.fn();
    const budget = await resolveGatewayShutdownBudget(
      "launchd",
      { info: vi.fn(), warn },
      launchdOwnedStop,
    );
    expect(warn).not.toHaveBeenCalled();
    expect(budget.timeoutMs).toBe(15_000);
    expect(budget.nativeStopBudget).toBe(true);
  });

  // A probe that established nothing is the case the safety net exists for, so the
  // startup budget is held rather than widened.
  it("retains the startup budget when the job could not be inspected at all", async () => {
    delete process.env.OPENCLAW_SUPERVISOR_MODE;
    execLaunchctl.mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "permission denied",
      termination: "exit",
    });
    const warn = vi.fn();
    const budget = await resolveGatewayShutdownBudget(
      "launchd",
      { info: vi.fn(), warn },
      launchdOwnedStop,
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Unable to inspect the launchd job"));
    expect(warn).toHaveBeenCalledWith(
      "Retaining the startup shutdown budget of 15000ms because the current supervisor stop timeout could not be confirmed.",
    );
    expect(budget.timeoutMs).toBe(15_000);
  });

  // Warned but non-null is the defaulted-value case, not a failed probe: launchd is
  // confirmed to be stopping the job, so a clock is running and there is nothing to
  // retain. Warning about a timeout that "could not be confirmed" here would be the
  // same false statement in a different place.
  it("does not retain when only the deadline's value had to be defaulted", async () => {
    delete process.env.OPENCLAW_SUPERVISOR_MODE;
    execLaunchctl.mockResolvedValue(printed("SIGTERMed", "\tpid = 4242\n"));
    const warn = vi.fn();
    const budget = await resolveGatewayShutdownBudget(
      "launchd",
      { info: vi.fn(), warn },
      launchdOwnedStop,
    );
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("its exit timeout is missing or invalid"),
    );
    expect(budget.timeoutMs).toBe(15_000);
  });

  // No stop is running at startup, so there is no enforcing deadline to read and
  // no reason to spend a launchctl print discovering that.
  it("does not inspect the job at startup", async () => {
    const info = vi.fn();
    const budget = await resolveGatewayShutdownBudget("external", { info, warn: vi.fn() });
    budget.log("startup");
    expect(execLaunchctl).not.toHaveBeenCalled();
    expect(budget.timeoutMs).toBe(325_000);
    expect(budget.nativeStopBudget).toBe(false);
    expect(info).toHaveBeenCalledWith(
      "shutdown budget at startup: drain=315000ms shutdown=325000ms reserve=10000ms exitMargin=5000ms; source=Gateway stop policy=330000ms",
    );
  });

  it("keeps the platform-neutral policy when darwin is not running a launchd job", async () => {
    process.env = {};
    const warn = vi.fn();
    const budget = await resolveGatewayShutdownBudget(null, { info: vi.fn(), warn }, stoppingNow);
    expect(budget.timeoutMs).toBe(325_000);
    expect(budget.nativeStopBudget).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect(execLaunchctl).not.toHaveBeenCalled();
  });

  it("never reads systemd on darwin", async () => {
    execLaunchctl.mockResolvedValue(printed("SIGTERMed", "\texit timeout = 20\n\tpid = 4242\n"));
    await resolveGatewayShutdownBudget("external", { info: vi.fn(), warn: vi.fn() }, stoppingNow);
    expect(execSystem).not.toHaveBeenCalled();
    expect(execUser).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });
});
