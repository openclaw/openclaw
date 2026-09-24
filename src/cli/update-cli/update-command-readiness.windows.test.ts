import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { GatewayServiceRuntime } from "../../daemon/service-runtime.js";
import {
  createUpdateRun,
  getUpdateRun,
  recordUpdateRunPhase,
  recordUpdateRunStep,
} from "../../infra/update-run-ledger.js";
import { toPublicUpdateRun } from "../../infra/update-run-record.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { verifyPreviousGatewayForUpdate } from "./update-command-readiness.js";

const native = vi.hoisted(() => ({
  runtime: vi.fn<() => Promise<GatewayServiceRuntime>>(),
  command: vi.fn(),
  reachable: vi.fn(),
  http: vi.fn<typeof import("../daemon-cli/restart-health-probe.js").waitForGatewayHttpReadiness>(),
}));

vi.mock("../../daemon/service.js", () => ({
  resolveGatewayService: () => ({
    isLoaded: async () => false,
    readCommand: async () => null,
    readRuntime: native.runtime,
  }),
}));
vi.mock("../../daemon/gateway-service-probe-hosts.js", () => ({
  resolveGatewayServiceProbeHosts: async () => ["127.0.0.1"],
}));
vi.mock("../../process/exec.js", () => ({ runCommandWithTimeout: native.command }));
vi.mock("../../infra/ports-probe.js", () => ({ probePortUsage: async () => "busy" }));
vi.mock("../../infra/ports-inspect.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/ports-inspect.js")>();
  return {
    ...actual,
    inspectPortUsage: async (...args: Parameters<typeof actual.inspectPortUsage>) => {
      // SQLite keeps host paths; only native listener collection replays Windows.
      const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      try {
        return await actual.inspectPortUsage(...args);
      } finally {
        platform.mockRestore();
      }
    },
  };
});
vi.mock("../../infra/package-json.js", () => ({ readPackageVersion: async () => "2026.9.5" }));
vi.mock("../../infra/update-git-runtime.js", () => ({ readBuiltGatewayBuildId: async () => null }));
vi.mock("../../infra/gateway-owner-lease.js", () => ({ readGatewayOwnerLease: () => undefined }));
vi.mock("../../infra/startup-migration-checkpoint.js", () => ({
  STARTUP_MIGRATION_LEASE_TTL_MS: 300_000,
  STARTUP_MIGRATION_HEARTBEAT_INTERVAL_MS: 10_000,
  hasActiveStartupMigrationLease: () => false,
}));
vi.mock("../../gateway/local-http-probe.js", () => ({
  createConfiguredGatewayLocalProbe: () => ({}),
}));
vi.mock("../daemon-cli/restart-health-probe.js", () => ({
  GATEWAY_RESTART_PROBE_TIMEOUT_MS: 3_000,
  resolveGatewayRestartProbeContext: async () => ({ config: {} }),
  readGatewayStartupPhase: async () => undefined,
  confirmGatewayReachable: native.reachable,
  waitForGatewayHttpReadiness: native.http,
}));
vi.mock("./update-command-service-plan.js", () => ({
  resolveUpdatedGatewayRestartPort: async () => 18789,
  gatewayServiceCommandUsesRoot: async () => true,
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
const startedAt = Date.parse("2026-09-24T00:49:43Z");
const serviceRuntime = { status: "running", pid: 4242 } as const;
const unreachable = {
  reachable: false,
  gatewayVersion: null,
  gatewayBuildId: undefined,
  activatedPluginErrors: [],
  unavailablePlugins: [],
  channelProbeErrors: [],
  probeError: "Gateway RPC health probe timed out",
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(startedAt);
  native.runtime.mockReset().mockResolvedValue(serviceRuntime);
  native.reachable.mockReset().mockResolvedValue(unreachable);
  native.http.mockReset().mockResolvedValue({ healthz: 200, readyz: 200 });
  native.command.mockReset().mockImplementation(async (argv: string[]) => {
    const command = argv[0].toLowerCase();
    const stdout = command.endsWith("netstat.exe")
      ? "  TCP    127.0.0.1:18789    0.0.0.0:0    LISTENING    4242\r\n"
      : command.endsWith("tasklist.exe")
        ? '"node.exe","4242","Console","1","10,000 K"\r\n'
        : command.endsWith("powershell.exe")
          ? "node.exe C:\\openclaw\\dist\\index.js gateway run\r\n"
          : undefined;
    if (stdout === undefined) {
      throw new Error(`Unexpected fixture command: ${argv[0]}`);
    }
    return { stdout, stderr: "", code: 0 };
  });
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  closeOpenClawStateDatabaseForTest();
});

function fixture() {
  const env = { OPENCLAW_STATE_DIR: dirs.make("update-readiness-windows-") };
  const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
  recordUpdateRunPhase(run.runId, "validating", {}, { env });
  recordUpdateRunStep(
    run.runId,
    { step: "Checking Gateway startup", status: "completed", endedAtMs: startedAt, exitCode: 0 },
    { env },
  );
  const read = () => getUpdateRun(run.runId, { env })!;
  const wait = () => read().steps.find((step) => step.step === "previous gateway verification");
  return {
    read,
    wait,
    params: { root: "C:\\openclaw", config: {}, env, opts: { run }, gatewayPort: 18789 },
  };
}

function holdRuntimeProbe() {
  let release: ((runtime: GatewayServiceRuntime) => void) | undefined;
  let notify!: () => void;
  const entered = new Promise<void>((resolve) => {
    notify = resolve;
  });
  native.runtime.mockImplementationOnce(() => {
    notify();
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  return { entered, release: () => release?.(serviceRuntime) };
}

async function awaitProbe<T>(entered: Promise<T>, verification: Promise<boolean>): Promise<T> {
  return await Promise.race([
    entered,
    verification.then(() => {
      throw new Error("Readiness verification completed before the held probe was reached");
    }),
  ]);
}

describe("managed Windows update after the startup canary", () => {
  it.each([false, true])(
    "records the active readiness budget and refreshes its wait reason (json=%s)",
    async (json) => {
      const f = fixture();
      const probe = holdRuntimeProbe();
      const abort = new AbortController();
      const pending = verifyPreviousGatewayForUpdate({
        ...f.params,
        observedStartupMs: 300_000,
        opts: { ...f.params.opts, json },
        signal: abort.signal,
      });
      try {
        await awaitProbe(probe.entered, pending);
        expect(f.read()).toMatchObject({ phase: "validating", status: "running" });
        expect(f.wait()).toMatchObject({ status: "in_progress", startedAtMs: startedAt });
        expect(f.wait()?.detail).toMatch(/previous.Gateway readiness verification/i);
        expect(f.wait()?.detail).toContain("3000000");
        expect(f.wait()?.detail).toMatch(/300000.*10|10.*300000/);
        expect(f.wait()?.detail).toMatch(/service|Scheduled Task/i);
        expect(f.wait()?.detail).toMatch(/listener|identity/i);

        probe.release();
        await vi.advanceTimersByTimeAsync(30_000);

        const waiting = f.wait()!;
        expect(waiting.detail).toContain("Gateway RPC health probe timed out");
        expect(waiting.detail).toContain("4242");
        expect(waiting.detail).toContain("2970000");
        expect(waiting.startedAtMs).toBe(startedAt);
        expect(renderUpdateRunReport(f.read()).markdown).toContain(waiting.detail);
        expect(toPublicUpdateRun(f.read()).steps).toContainEqual(waiting);
        expect(defaultRuntime[json ? "error" : "log"]).toHaveBeenCalledWith(
          expect.stringContaining(waiting.detail!),
        );
        expect(defaultRuntime[json ? "log" : "error"]).not.toHaveBeenCalled();
        expect(native.command.mock.calls.some(([argv]) => argv[0].endsWith("tasklist.exe"))).toBe(
          true,
        );
        expect(native.command.mock.calls.some(([argv]) => argv[0].endsWith("powershell.exe"))).toBe(
          true,
        );
      } finally {
        abort.abort(new Error("fixture completed"));
        probe.release();
        await Promise.allSettled([pending]);
      }
    },
  );

  it("keeps HTTP endpoint results visible while readiness remains pending", async () => {
    const f = fixture();
    const abort = new AbortController();
    native.reachable.mockResolvedValue({
      ...unreachable,
      reachable: true,
      gatewayVersion: "2026.9.5",
      gatewayBootId: "previous-gateway-boot",
      probeError: undefined,
    });
    type HttpParams = Parameters<typeof native.http>[0];
    let notify!: (params: HttpParams) => void;
    let release: ((result: { healthz: number; readyz: number }) => void) | undefined;
    const entered = new Promise<HttpParams>((resolve) => {
      notify = resolve;
    });
    native.http.mockImplementationOnce((params) => {
      notify(params);
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const pending = verifyPreviousGatewayForUpdate({ ...f.params, signal: abort.signal });
    try {
      const http = await awaitProbe(entered, pending);
      await vi.advanceTimersByTimeAsync(30_000);
      http.onObservation?.({ healthz: 200, readyz: 503 });
      const waiting = f.wait()!;
      expect(waiting.status).toBe("in_progress");
      expect(waiting.detail).toContain("HTTP healthz=200; readyz=503");
      expect(waiting.detail).toContain("270000");
      expect(renderUpdateRunReport(f.read()).markdown).toContain("HTTP healthz=200; readyz=503");
    } finally {
      abort.abort(new Error("fixture completed"));
      release?.({ healthz: 200, readyz: 200 });
      await Promise.allSettled([pending]);
    }
  });

  it.each([
    { observedStartupMs: 0, timeoutMs: undefined, budgetMs: 300_000, reason: "min(3600000ms" },
    {
      observedStartupMs: 600_000,
      timeoutMs: undefined,
      budgetMs: 3_600_000,
      reason: "min(3600000ms",
    },
    {
      observedStartupMs: 600_000,
      timeoutMs: 7_200_000,
      budgetMs: 7_200_000,
      reason: "explicit --timeout",
    },
  ])(
    "publishes the selected $budgetMs ms budget before waiting",
    async ({ observedStartupMs, timeoutMs, budgetMs, reason }) => {
      const f = fixture();
      const probe = holdRuntimeProbe();
      const abort = new AbortController();
      const pending = verifyPreviousGatewayForUpdate({
        ...f.params,
        observedStartupMs,
        timeoutMs,
        signal: abort.signal,
      });
      try {
        await awaitProbe(probe.entered, pending);
        expect(f.wait()?.detail).toContain(`Budget ${budgetMs}ms`);
        expect(f.wait()?.detail).toContain(reason);
      } finally {
        abort.abort(new Error("fixture completed"));
        probe.release();
        await Promise.allSettled([pending]);
      }
    },
  );

  it("records a warning and an operator next step when its explicit readiness budget expires", async () => {
    const f = fixture();
    const pending = verifyPreviousGatewayForUpdate({ ...f.params, timeoutMs: 1_000 });
    await Promise.all([expect(pending).resolves.toBe(false), vi.advanceTimersByTimeAsync(1_000)]);

    const warning = f
      .read()
      .steps.find((step) => step.step === "warning:previous gateway verification");
    expect(warning).toMatchObject({ status: "completed" });
    expect(warning?.detail).toMatch(/1000/);
    expect(warning?.detail).toMatch(/openclaw gateway status/);
    expect(f.read().status).toBe("running");
    expect(renderUpdateRunReport(f.read()).markdown).toContain(warning?.detail);
  });

  it.each(["cancellation", "execution ownership loss"])(
    "does not publish more progress after %s during a native probe",
    async (cause) => {
      const f = fixture();
      const abort = new AbortController();
      const probe = holdRuntimeProbe();
      let owned = true;
      const pending = verifyPreviousGatewayForUpdate({
        ...f.params,
        signal: abort.signal,
        assertCurrent: () => {
          if (!owned) {
            throw new Error("execution ownership lost");
          }
        },
      });
      try {
        await awaitProbe(probe.entered, pending);
        const before = f.read();
        expect(f.wait()).toMatchObject({ status: "in_progress" });
        if (cause === "cancellation") {
          abort.abort(new Error("observation canceled"));
        } else {
          owned = false;
        }
        probe.release();
        await expect(pending).rejects.toThrow(
          cause === "cancellation" ? "observation canceled" : "execution ownership lost",
        );
        expect(f.read()).toEqual(before);
      } finally {
        abort.abort(new Error("fixture completed"));
        probe.release();
        await Promise.allSettled([pending]);
      }
    },
  );
});
