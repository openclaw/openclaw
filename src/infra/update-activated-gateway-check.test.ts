import { beforeEach, expect, it, vi } from "vitest";
import type { stopCanary } from "./update-candidate-canary-process.js";
import type { UpdateFailureFact } from "./update-failure-facts.js";
import type { UpdateRunResult } from "./update-runner-types.js";
import type { UpdateStepResult } from "./update-step-result.js";

const mocks = vi.hoisted(() => ({
  owner: vi.fn(),
  entry: vi.fn(),
  port: vi.fn(),
  launch: vi.fn(),
  stop: vi.fn(),
  ready: vi.fn(),
}));
// mock-isolation: the check must never read a real Gateway lock, bind a port or spawn a Gateway.
vi.mock("./gateway-lock.js", () => ({ readActiveGatewayLockIdentity: mocks.owner }));
// mock-isolation: entrypoint resolution reads the real install tree.
vi.mock("../daemon/gateway-entrypoint.js", () => ({
  resolveGatewayInstallEntrypoint: mocks.entry,
}));
// mock-isolation: port probing binds real sockets.
vi.mock("./ports-probe.js", () => ({ tryListenOnPort: mocks.port }));
// mock-isolation: launching spawns a real Gateway process.
vi.mock("./update-candidate-canary-process.js", () => ({
  launchCanary: mocks.launch,
  stopCanary: mocks.stop,
}));
// mock-isolation: readiness polls a real HTTP endpoint.
vi.mock("./update-candidate-canary-readiness.js", () => ({
  observeUpdateCandidateStartup: () => ({ onLine: () => {}, milestones: new Map() }),
  waitForUpdateCandidateReadiness: mocks.ready,
}));

const { checkActivatedGatewayStartup } = await import("./update-activated-gateway-check.js");

const activated: UpdateRunResult = {
  status: "ok",
  mode: "git",
  root: "/install",
  steps: [],
  durationMs: 1,
};
const check = (result = activated, gateway?: { remote: boolean; tls: boolean }) =>
  checkActivatedGatewayStartup({
    result,
    gateway,
    env: {},
    stateDir: "/state",
    assertCurrent: () => {},
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.owner.mockResolvedValue(undefined);
  mocks.entry.mockResolvedValue("/install/dist/index.js");
  mocks.port.mockResolvedValue(43210);
  mocks.launch.mockReturnValue({
    child: { once: vi.fn().mockReturnThis(), exitCode: 1, signalCode: null },
    failureFacts: [],
    processExited: () => false,
    hasExited: () => false,
    stderrDiagnostic: () => undefined,
  });
});

it("keeps an activated release whose Gateway becomes ready", async () => {
  mocks.ready.mockResolvedValue(undefined);
  const result = await check();
  expect(result.status).toBe("ok");
  expect(result.steps.at(-1)).toMatchObject({ name: "activated-gateway-startup", exitCode: 0 });
  expect(mocks.launch.mock.calls[0]?.[0].env).toMatchObject({
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_SKIP_CRON: "1",
  });
  expect(mocks.stop).toHaveBeenCalledOnce();
});

it("fails the update when the activated Gateway cannot start", async () => {
  mocks.ready.mockRejectedValue(new Error("Gateway failed to start"));
  const result = await check();
  expect(result).toMatchObject({ status: "error", reason: "activated-gateway-startup-failed" });
  expect(mocks.stop).toHaveBeenCalledOnce();
});

it("does not start a second Gateway on state another Gateway owns", async () => {
  mocks.owner.mockResolvedValue({ pid: 4242 });
  const result = await check();
  expect(result.status).toBe("ok");
  expect(result.steps.at(-1)?.advisory?.message).toContain("pid 4242");
  expect(mocks.launch).not.toHaveBeenCalled();
});

it("leaves failed or rootless results to their existing owner", async () => {
  const failed = { ...activated, status: "error" as const, reason: "doctor-failed" };
  expect(await check(failed)).toBe(failed);
  expect(mocks.owner).not.toHaveBeenCalled();
});

it.each([
  [{ remote: true, tls: false }, "does not configure a local Gateway"],
  [{ remote: false, tls: true }, "serves TLS"],
])("reports a non-check instead of failing %o", async (gateway, message) => {
  const result = await check(activated, gateway);
  expect(result.status).toBe("ok");
  expect(result.steps.at(-1)?.advisory?.message).toContain(message);
  expect(mocks.launch).not.toHaveBeenCalled();
});

it("settles preparation errors as a failed update so rollback runs", async () => {
  mocks.port.mockRejectedValue(Object.assign(new Error("bind"), { code: "EADDRNOTAVAIL" }));
  const result = await check();
  expect(result).toMatchObject({ status: "error", reason: "activated-gateway-startup-failed" });
  expect(mocks.launch).not.toHaveBeenCalled();
});

it("retains facts flushed while stopping the child", async () => {
  const facts: UpdateFailureFact[] = [];
  mocks.launch.mockReturnValue({
    child: { once: vi.fn().mockReturnThis(), exitCode: 1, signalCode: null },
    failureFacts: facts,
    processExited: () => true,
    hasExited: () => true,
    stderrDiagnostic: () => undefined,
  });
  mocks.ready.mockRejectedValue(new Error("Gateway exited"));
  mocks.stop.mockImplementation(async () => {
    facts.push({
      check: "startupz",
      code: "candidate-startup-failed",
      message: "plugin load failed",
    });
  });
  const result = await check();
  expect(result.steps.at(-1)?.failureFacts).toEqual(facts);
});

it.each(["signal", "timeout"] as const)(
  "preserves %s before cleanup signals the child",
  async (kind) => {
    const child = {
      once: vi.fn().mockReturnThis(),
      exitCode: null,
      signalCode: kind === "signal" ? "SIGTERM" : null,
    };
    mocks.launch.mockReturnValue({
      child,
      failureFacts: [],
      processExited: () => kind === "signal",
      hasExited: () => kind === "signal",
      stderrDiagnostic: () => undefined,
    });
    mocks.ready.mockRejectedValue(
      kind === "timeout"
        ? new DOMException("Startup stalled", "TimeoutError")
        : new Error("Exited"),
    );
    mocks.stop.mockImplementation(async () => {
      child.signalCode = "SIGKILL";
    });
    const result = await check();
    expect(result.status).toBe("error");
    expect(result.steps.at(-1)).toMatchObject({
      exitCode: null,
      termination: kind,
      ...(kind === "signal" ? { signal: "SIGTERM" } : {}),
      failureFacts: [
        { message: kind === "signal" ? "startup crash with signal SIGTERM" : "readiness timeout" },
      ],
    });
  },
);

it("keeps termination and producer facts within the persisted five-fact bound", async () => {
  const facts: UpdateFailureFact[] = Array.from({ length: 5 }, (_, index) => ({
    check: "startupz",
    code: "candidate-startup-failed",
    message: `cause-${index}`,
  }));
  mocks.launch.mockReturnValue({
    child: { once: vi.fn().mockReturnThis(), exitCode: null, signalCode: null },
    failureFacts: facts,
    processExited: () => false,
    hasExited: () => false,
    stderrDiagnostic: () => undefined,
  });
  mocks.ready.mockRejectedValue(new DOMException("Startup stalled", "TimeoutError"));
  const result = await check();
  expect(result.steps[0]?.failureFacts).toHaveLength(5);
  expect(result.steps[0]?.failureFacts?.[0]?.message).toBe("readiness timeout");
  expect(result.steps[0]?.failureFacts?.slice(1)).toEqual(facts.slice(0, 4));
  expect(result.steps[0]?.termination).toBe("timeout");
});

it.each([true, false])("retains incomplete cleanup after readiness=%s", async (ready) => {
  const cleanup: UpdateStepResult = {
    name: "activated-gateway-startup-cleanup",
    command: "SIGTERM, SIGKILL",
    cwd: "/install",
    durationMs: 1,
    exitCode: null,
    advisory: { kind: "recoverable-maintenance", message: "Cleanup remains unconfirmed" },
  };
  if (ready) {
    mocks.ready.mockResolvedValue(undefined);
  } else {
    mocks.ready.mockRejectedValue(new Error("Gateway exited"));
  }
  mocks.stop.mockImplementation(async ({ recordStep }: Parameters<typeof stopCanary>[0]) => {
    await recordStep(cleanup);
  });
  const result = await check();
  expect(result.status).toBe(ready ? "ok" : "error");
  expect(result.steps.at(-1)).toEqual(cleanup);
  expect(result.steps.at(-2)?.exitCode).toBe(ready ? 0 : 1);
});
