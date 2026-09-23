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
  inspect: vi.fn(),
}));
vi.mock("../cli/daemon-cli/restart-health-probe.js", () => ({
  resolveGatewayRestartProbeContext: probes.context,
  waitForGatewayHttpReadiness: probes.http,
}));
vi.mock("../cli/daemon-cli/restart-health.js", () => ({
  inspectGatewayRestart: probes.inspect,
  isSameGatewayRestartGeneration: (a: GatewayRestartSnapshot, b: GatewayRestartSnapshot) =>
    a.runtime.pid === b.runtime.pid && a.gatewayBootId === b.gatewayBootId,
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
  probes.inspect.mockReset().mockResolvedValue(healthy);
});
afterEach(() => vi.useRealTimers());

function after<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(value), ms);
  });
}

// The reporter's measured total was 25,431 ms; the phase distribution here is synthetic.
it.each([19_000, 25_431])(
  "settles a managed candidate taking %i ms across setup and reconciliation",
  async (elapsedMs) => {
    probes.root.mockImplementation(() => after(1_000, "/synthetic/root"));
    probes.context.mockImplementation(() => after(2_000, { config: {} }));
    probes.wait.mockImplementation(() => after(elapsedMs - 7_000, healthy));
    probes.http.mockImplementation(() => after(2_000, { healthz: 200, readyz: 200 }));
    probes.inspect.mockImplementation(() => after(1_000, healthy));
    const result = observe();
    await vi.advanceTimersByTimeAsync(INTERRUPTED_UPDATE_SETTLE_TIMEOUT_MS);
    expect(await result).toMatchObject({
      outcome: "settled",
      elapsedMs,
      waitOutcome: "healthy",
      verification: { settled: true, readyz: true, runningBuildId: "b1" },
    });
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each([
  ["root", 1, "setup:package-root"],
  ["version", 1, "setup:installed-identity"],
  ["context", 1, "setup:probe-context"],
  ["wait", 1, "health-wait"],
  ["http", 1, "reconciliation:http"],
  ["inspect", 1, "reconciliation:inspect-before"],
  ["inspect", 2, "reconciliation:inspect-after"],
  ["build", 2, "reconciliation:installed-identity"],
] as const)("bounds a stalled %s read #%s and records %s", async (probe, occurrence, phase) => {
  const pending = createDeferredCore<never>();
  if (occurrence === 2) {
    probes[probe].mockResolvedValueOnce(probe === "inspect" ? healthy : candidate.buildId);
  }
  probes[probe].mockReturnValueOnce(pending.promise);
  let completed = false;
  const result = observe().then((value) => {
    completed = true;
    return value;
  });
  await vi.advanceTimersByTimeAsync(INTERRUPTED_UPDATE_SETTLE_TIMEOUT_MS);
  expect(completed).toBe(true);
  expect(await result).toMatchObject({
    outcome: "timed-out",
    elapsedMs: INTERRUPTED_UPDATE_SETTLE_TIMEOUT_MS,
    phase,
  });
  const calls = probes.inspect.mock.calls.length;
  pending.reject(new Error("late read failed"));
  await vi.advanceTimersByTimeAsync(500);
  expect(probes.inspect).toHaveBeenCalledTimes(calls);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not grant new HTTP or inspection budgets after a slow healthy settle", async () => {
  probes.wait.mockImplementation(() =>
    after(INTERRUPTED_UPDATE_SETTLE_TIMEOUT_MS - 6_500, healthy),
  );
  probes.http.mockImplementation(() => after(4_000, { healthz: 200, readyz: 200 }));
  probes.inspect.mockImplementation(() => after(4_000, healthy));
  let completed = false;
  const result = observe().then((value) => {
    completed = true;
    return value;
  });
  await vi.advanceTimersByTimeAsync(INTERRUPTED_UPDATE_SETTLE_TIMEOUT_MS);
  expect(completed).toBe(true);
  expect(await result).toMatchObject({
    outcome: "timed-out",
    elapsedMs: INTERRUPTED_UPDATE_SETTLE_TIMEOUT_MS,
    phase: "reconciliation:inspect-before",
    waitOutcome: "healthy",
  });
  await vi.advanceTimersByTimeAsync(4_000);
  expect(probes.inspect).toHaveBeenCalledTimes(1);
});

it("records an early identity mismatch as unverified rather than a timeout", async () => {
  probes.wait.mockResolvedValue({ ...healthy, healthy: false, waitOutcome: "build-id-mismatch" });
  expect(await observe()).toMatchObject({
    outcome: "unverified",
    elapsedMs: 0,
    phase: "health-wait",
    waitOutcome: "build-id-mismatch",
  });
  expect(probes.http).not.toHaveBeenCalled();
});

it.each(["http", "generation", "installed"])(
  "does not settle with changed %s evidence",
  async (change) => {
    if (change === "http") {
      probes.http.mockResolvedValue({ healthz: 200, readyz: 503 });
    } else if (change === "generation") {
      probes.inspect
        .mockResolvedValueOnce(healthy)
        .mockResolvedValue({ ...healthy, gatewayBootId: "boot-2" });
    } else {
      probes.build.mockResolvedValueOnce(candidate.buildId).mockResolvedValue("other-build");
    }
    const result = await observe();
    expect(result.outcome).toBe("unverified");
    expect(result.verification).toBeUndefined();
  },
);

it("preserves command cleanup uncertainty for the reconciliation owner", async () => {
  const failure = new CommandProcessCleanupError();
  probes.wait.mockRejectedValue(failure);
  await expect(observe()).rejects.toBe(failure);
});
