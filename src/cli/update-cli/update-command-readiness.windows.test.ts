import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as startupTiming from "../../commands/gateway-startup-timing.js";
import type { GatewayServiceRuntime } from "../../daemon/service-runtime.js";
import type { GatewayService } from "../../daemon/service.js";
import * as ledger from "../../infra/update-run-ledger.js";
import { toPublicUpdateRun } from "../../infra/update-run-record.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withMockedWindowsPlatform } from "../../test-utils/vitest-spies.js";
import { verifyPreviousGatewayForUpdate } from "./update-command-readiness.js";

const resolveGatewayStartupTiming = startupTiming.resolveGatewayStartupTiming;

const native = vi.hoisted(() => ({
  runtime: vi.fn<GatewayService["readRuntime"]>(),
  command: vi.fn(),
  reachable: vi.fn(),
  http: vi.fn<typeof import("../daemon-cli/restart-health-probe.js").waitForGatewayHttpReadiness>(),
}));

// mock-isolation: Windows readiness uses fixture service state without inspecting the host service manager.
vi.mock("../../daemon/service.js", () => ({
  resolveGatewayService: () => ({
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
    inspectPortUsage: (...args: Parameters<typeof actual.inspectPortUsage>) =>
      // SQLite keeps host paths; only native listener collection replays Windows.
      withMockedWindowsPlatform(() => actual.inspectPortUsage(...args)),
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
const cleanups: (() => Promise<void>)[] = [];
const startedAt = Date.parse("2026-09-24T00:49:43Z");
const serviceRuntime = { status: "running", pid: 4242 } as const;
const census: Record<string, string> = {
  "netstat.exe": "  TCP    127.0.0.1:18789    0.0.0.0:0    LISTENING    4242\r\n",
  "tasklist.exe": '"node.exe","4242","Console","1","10,000 K"\r\n',
  "powershell.exe": "node.exe C:\\openclaw\\dist\\index.js gateway run\r\n",
};
const unreachable = {
  reachable: false,
  gatewayVersion: null,
  probeError: "Gateway RPC health probe timed out",
};

beforeEach(() => {
  // Exercise Windows budgets on every host without changing SQLite's host paths.
  vi.spyOn(startupTiming, "resolveGatewayStartupTiming").mockImplementation((_, update) =>
    resolveGatewayStartupTiming("win32", update),
  );
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(startedAt);
  native.runtime.mockReset().mockResolvedValue(serviceRuntime);
  native.reachable.mockReset().mockResolvedValue(unreachable);
  native.http.mockReset().mockResolvedValue({ healthz: 200, readyz: 200 });
  native.command.mockReset().mockImplementation(async ([executable]: string[]) => {
    const stdout = census[path.win32.basename(executable ?? "").toLowerCase()];
    assert(stdout !== undefined, `Unexpected fixture command: ${executable}`);
    return { stdout, stderr: "", code: 0 };
  });
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
  closeOpenClawStateDatabaseForTest();
});

function fixture() {
  const env = { OPENCLAW_STATE_DIR: dirs.make("update-readiness-windows-") };
  const run = { runId: ledger.createUpdateRun({ trigger: "cli" }, { env }).runId, env };
  ledger.recordUpdateRunPhase(run.runId, "validating", {}, { env });
  const read = () => ledger.getUpdateRun(run.runId, { env })!;
  const wait = (prefix = "") =>
    read().steps.find((step) => step.step === `${prefix}previous gateway verification`);
  return {
    read,
    wait,
    observe(
      release: () => void,
      options: Partial<Parameters<typeof verifyPreviousGatewayForUpdate>[0]> = {},
      json = false,
    ) {
      const abort = new AbortController();
      const pending = verifyPreviousGatewayForUpdate({
        root: "C:\\openclaw",
        config: {},
        env,
        gatewayPort: 18789,
        waitForStartup: false,
        ...options,
        opts: { run, json },
        signal: abort.signal,
      });
      cleanups.push(async () => {
        abort.abort(new Error("fixture completed"));
        release();
        await Promise.allSettled([pending]);
      });
      return { pending, abort };
    },
  };
}

function holdRuntimeProbe() {
  const entered = createDeferred();
  const result = createDeferred<GatewayServiceRuntime>();
  native.runtime.mockImplementationOnce(() => {
    entered.resolve();
    return result.promise;
  });
  return { entered: entered.promise, release: () => result.resolve(serviceRuntime) };
}

async function awaitProbe<T>(entered: Promise<T>, verification: Promise<boolean>): Promise<T> {
  return awaitGateBeforeSettlement(
    entered,
    verification,
    "Readiness verification completed before the held probe was reached",
  );
}

it.each([
  [false, 300_000, undefined, 5_400_000],
  [true, 300_000, undefined, 5_400_000],
  [false, 600_000, 7_200_000, 7_200_000],
  [false, undefined, 1_000, 1_000],
] as const)(
  "records the bounded observation budget (json=%s, startup=%s, timeout=%s)",
  async (json, observedStartupMs, timeoutMs, budgetMs) => {
    const f = fixture();
    const probe = holdRuntimeProbe();
    const { pending } = f.observe(probe.release, { observedStartupMs, timeoutMs }, json);
    await awaitProbe(probe.entered, pending);
    expect(f.read()).toMatchObject({ phase: "validating", status: "running" });
    expect(f.wait()).toMatchObject({
      status: "in_progress",
      startedAtMs: startedAt,
      detail: expect.stringContaining(`Budget ${budgetMs}ms`),
    });
    if (timeoutMs === undefined) {
      expect(f.wait()?.detail).toMatch(
        new RegExp(`${observedStartupMs}.*10|10.*${observedStartupMs}`),
      );
    }

    const elapsedMs = timeoutMs === 1_000 ? 1_000 : 30_000;
    await vi.advanceTimersByTimeAsync(elapsedMs);
    probe.release();
    await expect(pending).resolves.toBe(false);

    const waiting = f.wait("warning:")!;
    expect(waiting).toMatchObject({
      status: "completed",
      startedAtMs: startedAt,
      endedAtMs: startedAt + elapsedMs,
    });
    if (timeoutMs === 1_000) {
      expect(waiting.detail).toMatch(/1000/);
      expect(waiting.detail).toMatch(/openclaw gateway status/);
    } else {
      expect(waiting.detail).toContain("Gateway RPC health probe timed out");
    }
    expect(waiting.detail).toContain("continuing with readiness unverified");
    expect(f.read().status).toBe("running");
    expect(renderUpdateRunReport(f.read()).markdown).toContain(waiting.detail);
    expect(toPublicUpdateRun(f.read()).steps).toContainEqual(waiting);
    expect(defaultRuntime[json ? "error" : "log"]).toHaveBeenCalledWith(
      expect.stringContaining(waiting.detail!),
    );
    expect(defaultRuntime[json ? "log" : "error"]).not.toHaveBeenCalled();
  },
);

it("keeps HTTP endpoint results visible while readiness remains pending", async () => {
  const f = fixture();
  native.reachable.mockResolvedValue({
    ...unreachable,
    reachable: true,
    gatewayVersion: "2026.9.5",
    gatewayBootId: "previous-gateway-boot",
    probeError: undefined,
  });
  type HttpParams = Parameters<typeof native.http>[0];
  const entered = createDeferred<HttpParams>();
  const result = createDeferred<{ healthz: number; readyz: number }>();
  native.http.mockImplementationOnce((params) => {
    entered.resolve(params);
    return result.promise;
  });
  const { pending } = f.observe(() => result.resolve({ healthz: 200, readyz: 200 }));
  const http = await awaitProbe(entered.promise, pending);
  await vi.advanceTimersByTimeAsync(30_000);
  http.onObservation?.({ healthz: 200, readyz: 503 });
  const waiting = f.wait()!;
  expect(waiting.status).toBe("in_progress");
  expect(waiting.detail).toContain("HTTP healthz=200; readyz=503");
  expect(waiting.detail).toContain("Remaining 5370000ms");
  expect(renderUpdateRunReport(f.read()).markdown).toContain("HTTP healthz=200; readyz=503");
});

it.each(["cancellation", "execution ownership loss"])(
  "does not publish more progress after %s during a native probe",
  async (cause) => {
    const f = fixture();
    const probe = holdRuntimeProbe();
    let owned = true;
    const { pending, abort } = f.observe(probe.release, {
      assertCurrent: () => {
        if (!owned) {
          throw new Error("execution ownership lost");
        }
      },
    });
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
  },
);
