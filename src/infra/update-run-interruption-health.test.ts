import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createGatewayRestartDeadline } from "../cli/daemon-cli/restart-health-deadline.js";
import { INTERRUPTED_UPDATE_SETTLE_TIMEOUT_MS } from "../cli/daemon-cli/restart-health.constants.js";
import type { GatewayRestartSnapshot } from "../cli/daemon-cli/restart-health.types.js";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import { createDeferredCore } from "../shared/deferred.js";

const probes = vi.hoisted(() => ({
  root: vi.fn(),
  version: vi.fn(),
  build: vi.fn(),
  context: vi.fn(),
  wait: vi.fn(),
  http: vi.fn(),
}));
vi.mock("../cli/daemon-cli/restart-health-probe.js", () => ({
  resolveGatewayRestartProbeContext: probes.context,
  waitForGatewayHttpReadiness: probes.http,
}));
vi.mock("../cli/daemon-cli/restart-health.js", async (original) => ({
  ...(await original<typeof import("../cli/daemon-cli/restart-health.js")>()),
  waitForGatewayHealthyRestart: probes.wait,
}));
vi.mock("../config/paths.js", () => ({ resolveGatewayPort: () => 18789 }));
vi.mock("../daemon/service.js", () => ({ resolveGatewayService: () => ({}) }));
vi.mock("./openclaw-root.js", () => ({ resolveOpenClawPackageRoot: probes.root }));
vi.mock("./package-json.js", () => ({ readPackageVersion: probes.version }));
vi.mock("./update-git-runtime.js", () => ({ readBuiltGatewayBuildId: probes.build }));

const { observeInterruptedUpdateGateway } = await import("./update-run-interruption-health.js");
const candidate = { version: "1.0.0", buildId: "b1" };
async function observe() {
  const deadline = createGatewayRestartDeadline({
    timeoutMs: INTERRUPTED_UPDATE_SETTLE_TIMEOUT_MS,
  });
  try {
    return await observeInterruptedUpdateGateway(candidate, { deadline });
  } finally {
    deadline.dispose();
  }
}
const healthy: GatewayRestartSnapshot = {
  healthy: true,
  runtime: { status: "running", pid: 1 },
  portUsage: { status: "busy", port: 18789, listeners: [{ pid: 1 }], hints: [] },
  staleGatewayPids: [],
  gatewayBootId: "boot-1",
  gatewayVersion: candidate.version,
  gatewayBuildId: candidate.buildId,
  waitOutcome: "healthy",
};
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  probes.root.mockReset().mockResolvedValue("/synthetic/root");
  probes.version.mockReset().mockResolvedValue(candidate.version);
  probes.build.mockReset().mockResolvedValue(candidate.buildId);
  probes.context.mockReset().mockResolvedValue({ auth: undefined, config: {} });
  probes.wait.mockReset().mockResolvedValue(healthy);
  probes.http.mockReset().mockResolvedValue({ healthz: 200, readyz: 200 });
});
afterEach(() => vi.useRealTimers());

function after<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(value), ms);
  });
}

async function expireObservation() {
  let completed = false;
  const result = observe().then((value) => {
    completed = true;
    return value;
  });
  await vi.advanceTimersByTimeAsync(INTERRUPTED_UPDATE_SETTLE_TIMEOUT_MS);
  expect(completed).toBe(true);
  return result;
}

// The reporter's measured total was 25,431 ms; the phase distribution here is synthetic.
it("settles a managed candidate taking 25,431 ms across setup and reconciliation", async () => {
  const elapsedMs = 25_431;
  probes.root.mockImplementation(() => after(1_000, "/synthetic/root"));
  probes.context.mockImplementation(() => after(2_000, { config: {} }));
  probes.wait.mockImplementation(() => after(elapsedMs - 5_000, healthy));
  probes.http.mockImplementation(() => after(2_000, { healthz: 200, readyz: 200 }));
  const result = observe();
  await vi.advanceTimersByTimeAsync(INTERRUPTED_UPDATE_SETTLE_TIMEOUT_MS);
  expect(await result).toMatchObject({
    outcome: "settled",
    elapsedMs,
    waitOutcome: "healthy",
    verification: { settled: true, readyz: true, runningBuildId: "b1" },
  });
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  ["root", "setup:package-root"],
  ["version", "setup:installed-identity"],
  ["context", "setup:probe-context"],
  ["wait", "health-wait"],
  ["http", "reconciliation:http"],
] as const)("bounds a stalled %s read and records %s", async (probe, phase) => {
  const pending = createDeferredCore<never>();
  probes[probe].mockReturnValueOnce(pending.promise);
  expect(await expireObservation()).toMatchObject({
    outcome: "timed-out",
    elapsedMs: INTERRUPTED_UPDATE_SETTLE_TIMEOUT_MS,
    phase,
  });
  const calls = probes.http.mock.calls.length;
  pending.reject(new Error("late read failed"));
  await vi.advanceTimersByTimeAsync(500);
  expect(probes.http).toHaveBeenCalledTimes(calls);
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps HTTP readiness in the original budget after a slow healthy settle", async () => {
  probes.wait.mockImplementation(() =>
    after(INTERRUPTED_UPDATE_SETTLE_TIMEOUT_MS - 2_500, healthy),
  );
  probes.http.mockImplementation(() => after(4_000, { healthz: 200, readyz: 200 }));
  expect(await expireObservation()).toMatchObject({
    outcome: "timed-out",
    elapsedMs: INTERRUPTED_UPDATE_SETTLE_TIMEOUT_MS,
    phase: "reconciliation:http",
    waitOutcome: "healthy",
  });
  await vi.advanceTimersByTimeAsync(4_000);
  expect(probes.http).toHaveBeenCalledTimes(1);
});

it.each(["wait", "http", "installed"])(
  "does not settle with changed %s evidence",
  async (change) => {
    if (change === "wait") {
      probes.wait.mockResolvedValue({
        ...healthy,
        healthy: false,
        waitOutcome: "build-id-mismatch",
      });
    } else if (change === "http") {
      probes.http.mockResolvedValue({ healthz: 200, readyz: 503 });
    } else {
      probes.build.mockResolvedValue("other-build");
    }
    const result = await observe();
    expect(result.outcome).toBe("unverified");
    expect(result.verification).toBeUndefined();
    if (change === "wait") {
      expect(result).toMatchObject({
        elapsedMs: 0,
        phase: "health-wait",
        waitOutcome: "build-id-mismatch",
      });
      expect(probes.http).not.toHaveBeenCalled();
    }
  },
);

it("preserves command cleanup uncertainty for the reconciliation owner", async () => {
  const failure = new CommandProcessCleanupError();
  probes.wait.mockRejectedValue(failure);
  await expect(observe()).rejects.toBe(failure);
});
