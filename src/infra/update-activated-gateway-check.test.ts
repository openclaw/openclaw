import { beforeEach, expect, it, vi } from "vitest";
import type { UpdateRunResult } from "./update-runner-types.js";

const mocks = vi.hoisted(() => ({
  owner: vi.fn(),
  entry: vi.fn(),
  port: vi.fn(),
  launch: vi.fn(),
  stop: vi.fn(),
  ready: vi.fn(),
}));
vi.mock("./gateway-lock.js", () => ({ readActiveGatewayLockIdentity: mocks.owner }));
vi.mock("../daemon/gateway-entrypoint.js", () => ({
  resolveGatewayInstallEntrypoint: mocks.entry,
}));
vi.mock("./ports-probe.js", () => ({ tryListenOnPort: mocks.port }));
vi.mock("./update-candidate-canary-process.js", () => ({
  launchCanary: mocks.launch,
  stopCanary: mocks.stop,
}));
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
const check = (result = activated) =>
  checkActivatedGatewayStartup({
    result,
    env: {},
    stateDir: "/state",
    assertCurrent: () => {},
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.owner.mockResolvedValue(undefined);
  mocks.entry.mockResolvedValue("/install/dist/index.js");
  mocks.port.mockResolvedValue(43210);
  mocks.launch.mockReturnValue({
    child: { once: vi.fn().mockReturnThis(), exitCode: 1 },
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
  expect(mocks.launch.mock.calls[0][0].env).toMatchObject({
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
