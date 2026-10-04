import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  callGateway,
  inspectPortUsage,
  monotonicClock,
  readBestEffortConfig,
  requestStartupProbe,
  resetRestartHealthMocks,
  restoreRestartHealthMocks,
} from "../cli/daemon-cli/restart-health.test-helpers.js";
import { gatewayHealthResponse } from "../gateway/health-response.test-support.js";
import type { ImmutableInstallDescriptor } from "./update-immutable-install-schema.js";
import type { ImmutableServiceObservation } from "./update-immutable-service.js";
import { waitForImmutableGateway } from "./update-immutable-verification.js";

const mocks = vi.hoisted(() => ({
  inspect:
    vi.fn<typeof import("./update-immutable-service.js").inspectImmutableActivationService>(),
  current:
    vi.fn<typeof import("./update-immutable-service.js").assertImmutableServiceProcessCurrent>(),
  runtime: vi.fn<typeof import("../daemon/systemd-runtime.js").readSystemdServiceRuntime>(),
  http: vi.fn<
    typeof import("../cli/daemon-cli/restart-health-probe.js").waitForGatewayHttpReadiness
  >(),
}));
vi.mock("./update-immutable-service.js", () => ({
  inspectImmutableActivationService: mocks.inspect,
  assertImmutableServiceProcessCurrent: mocks.current,
}));
vi.mock("../daemon/systemd-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/systemd-runtime.js")>()),
  readSystemdServiceRuntime: mocks.runtime,
}));
vi.mock("./package-json.js", () => ({ readPackageVersion: async () => "2026.10.3" }));
vi.mock("./update-git-runtime.js", () => ({ readBuiltGatewayBuildId: async () => "sealed-build" }));
vi.mock("../cli/daemon-cli/restart-health-probe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/daemon-cli/restart-health-probe.js")>()),
  waitForGatewayHttpReadiness: mocks.http,
}));

const generation = {
  path: `/synthetic/install/releases/${"b".repeat(40)}`,
  sha: "b".repeat(40),
  buildDigest: "c".repeat(64),
};
const descriptor: ImmutableInstallDescriptor = {
  version: 1,
  kind: "immutable",
  root: "/synthetic/install",
  rootIdentity: "1:2",
  releasesIdentity: "1:3",
  current: { ...generation, identity: "1:4", pointerIdentity: "1:5" },
  service: {
    unit: "synthetic.service",
    scope: "system",
    account: "synthetic",
    stateDir: "/synthetic/state",
    configPath: "/synthetic/state/openclaw.json",
    profile: null,
  },
  runtime: { path: "/synthetic/bin/node", identity: "node-fixture" },
  source: "https://github.com/openclaw/openclaw.git",
};
function serviceObservation(): ImmutableServiceObservation {
  return {
    phase: "running",
    definitionDigest: "d".repeat(64),
    pid: 8000,
    processStartTicks: "100",
    generationPath: generation.path,
    runtimePath: descriptor.runtime.path,
    controlGroup: "/system.slice/synthetic.service",
    state: {
      installed: true,
      loadState: { status: "loaded" },
      running: true,
      command: null,
      env: {},
      runtime: { status: "running", pid: 8000 },
    },
    identity: {
      scope: "system",
      unitName: "synthetic.service",
      unitPath: "/synthetic/service",
      bus: { address: "synthetic" },
      busId: "bus",
      managerOwner: "manager",
      managerUid: 0,
      serviceUser: "synthetic",
    },
  };
}
const health = (overrides: Parameters<typeof gatewayHealthResponse>[0] = {}) =>
  gatewayHealthResponse({
    ...overrides,
    server: {
      version: "2026.10.3",
      buildId: "sealed-build",
      bootId: "immutable-boot",
      ...overrides.server,
    },
  });
const observe = (assertCurrent = () => {}) =>
  waitForImmutableGateway({ descriptor, generation, timeoutMs: 120_000, assertCurrent });

beforeEach(() => {
  resetRestartHealthMocks();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  mocks.inspect.mockReset().mockImplementation(async () => serviceObservation());
  mocks.current.mockReset();
  mocks.runtime.mockReset().mockResolvedValue({ status: "running", pid: 8000 });
  mocks.http.mockReset().mockResolvedValue({ healthz: 200, readyz: 200 });
  inspectPortUsage.mockResolvedValue({
    status: "busy",
    port: 18789,
    listeners: [{ pid: 8000 }],
    hints: [],
  });
  callGateway.mockImplementation(health());
});
afterEach(() => {
  vi.useRealTimers();
  restoreRestartHealthMocks();
});

it("verifies the preserved service's explicit port instead of the config default", async () => {
  readBestEffortConfig.mockResolvedValue({ gateway: { port: 18789, auth: { mode: "none" } } });
  const service = serviceObservation();
  service.state.command = {
    programArguments: ["/synthetic/install/bin/openclaw-gateway", "--port", "19678"],
  };
  mocks.inspect.mockResolvedValue(service);
  inspectPortUsage.mockImplementation(async (port) => ({
    port,
    status: "busy",
    listeners: [{ pid: 8000 }],
    hints: [],
  }));

  const result = await observe();

  expect(result).toMatchObject({ outcome: "verified", verification: { port: 19678 } });
  expect(inspectPortUsage.mock.calls.every(([port]) => port === 19678)).toBe(true);
  expect(callGateway).toHaveBeenCalledWith(expect.objectContaining({ localPortOverride: 19678 }));
  expect(mocks.http).toHaveBeenCalledWith(expect.objectContaining({ port: 19678 }));
});

it.each([90_000, 150_000])(
  "waits for agent database inspection until the complete readiness budget (ready at %d ms)",
  async (readyAtMs) => {
    requestStartupProbe.mockImplementation(async () => ({
      statusCode: monotonicClock.nowMs < readyAtMs ? 503 : 200,
      body: JSON.stringify(
        monotonicClock.nowMs < readyAtMs
          ? { status: "starting", pendingReason: "agent-database-inspection" }
          : { status: "started" },
      ),
    }));
    callGateway.mockImplementation(async (options) => {
      if (monotonicClock.nowMs < readyAtMs) {
        throw new Error("Agent database inspection is pending; retry startup");
      }
      return health()(options);
    });
    const result = await observe();
    expect(result.outcome).toBe(readyAtMs < 120_000 ? "verified" : "still-starting");
    if (readyAtMs < 120_000) {
      expect(result.verification).toMatchObject({
        pid: 8000,
        bootId: "immutable-boot",
        generationSha: generation.sha,
        buildId: "sealed-build",
        channelsReady: true,
        pluginsReady: true,
        healthz: 200,
        readyz: 200,
      });
      expect(result.elapsedMs).toBeGreaterThanOrEqual(readyAtMs);
    } else {
      expect(result.elapsedMs).toBe(120_000);
      expect(result.verification).toBeUndefined();
      expect(mocks.http).not.toHaveBeenCalled();
    }
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each([
  { name: "version", server: { version: "previous-version" } },
  { name: "build", server: { buildId: "previous-build" } },
  { name: "channel", health: { channels: { synthetic: { probe: { ok: false } } } } },
  {
    name: "plugin",
    health: { plugins: { errors: [{ id: "synthetic", activated: true, error: "failed" }] } },
  },
])("reports a definitive $name failure without a verification receipt", async (failure) => {
  callGateway.mockImplementation(health(failure));
  const result = await observe();
  expect(result.outcome).toBe("failed");
  expect(result.verification).toBeUndefined();
});

it("leaves an unavailable health RPC unverified rather than authorizing rollback", async () => {
  callGateway.mockRejectedValue(new Error("connection refused"));
  expect(await observe()).toMatchObject({ outcome: "unverified", elapsedMs: 120_000 });
});

it.each(["process", "boot", "definition", "readiness", "physical-generation"])(
  "refuses success when %s changes after health settles",
  async (change) => {
    mocks.http.mockImplementation(async () => {
      if (change === "boot") {
        callGateway.mockImplementation(health({ server: { bootId: "different-boot" } }));
      } else if (change !== "readiness") {
        mocks.inspect.mockImplementation(async () => ({
          ...serviceObservation(),
          ...(change === "process" ? { processStartTicks: "200" } : {}),
          ...(change === "definition" ? { definitionDigest: "different-definition" } : {}),
          ...(change === "physical-generation" ? { generationPath: "/synthetic/foreign" } : {}),
        }));
      }
      return { healthz: 200, readyz: change === "readiness" ? 503 : 200 };
    });
    const result = await observe();
    expect(result.outcome).toBe("unverified");
    expect(result.verification).toBeUndefined();
  },
);

it("propagates revoked activation authority after asynchronous readiness", async () => {
  let current = true;
  const revoked = new Error("activation custody revoked");
  mocks.http.mockImplementation(async () => {
    current = false;
    return { healthz: 200, readyz: 200 };
  });
  await expect(
    observe(() => {
      if (!current) {
        throw revoked;
      }
    }),
  ).rejects.toBe(revoked);
});
