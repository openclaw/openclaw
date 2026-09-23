// Gateway lifecycle readiness tests distinguish healthy, still-starting, and failed outcomes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireMockCallArg, type RestartParams } from "./lifecycle.test-helpers.js";
import { formatGatewayRestartFailure } from "./restart-health-diagnostics.js";

const service = vi.hoisted(() => ({ readCommand: vi.fn(), restart: vi.fn() }));
const runServiceStart = vi.hoisted(() => vi.fn());
const runServiceRestart = vi.hoisted(() => vi.fn());
const terminateStaleGatewayPids = vi.hoisted(() => vi.fn());
const resolveGatewayStartupTiming = vi.hoisted(() => vi.fn(() => ({ deadlineMs: 45_000 })));
const waitForGatewayHealthyRestart = vi.hoisted(() => vi.fn());
const waitForGatewayHttpReadiness = vi.hoisted(() => vi.fn());
const renderRestartDiagnostics = vi.hoisted(() => vi.fn(() => ["runtime diagnostics"]));
const readServiceConfig = vi.hoisted(() => vi.fn());

vi.mock("../../commands/gateway-startup-timing.js", () => ({ resolveGatewayStartupTiming }));
vi.mock("../../config/config.js", () => ({
  readBestEffortConfig: vi.fn(async () => ({})),
  resolveGatewayPort: vi.fn(() => 18_789),
}));
vi.mock("../../config/io.js", () => ({
  createConfigIO: vi.fn(() => ({ readBestEffortConfig: () => readServiceConfig() })),
}));
vi.mock("../../daemon/service.js", () => ({ resolveGatewayService: () => service }));
vi.mock("../../infra/gateway-lock.js", () => ({
  readActiveGatewayLockPort: async () => undefined,
}));
vi.mock("../../infra/gateway-supervision.js", () => ({
  assertGatewayServiceMutationAllowed: vi.fn(),
  formatExternalSupervisorActionRequired: vi.fn(),
  isGatewayExternallySupervised: vi.fn(),
  resolveGatewayServiceMutationError: vi.fn(),
}));
vi.mock("./lifecycle-core.js", () => ({
  runServiceRestart,
  runServiceStart,
  runServiceStop: vi.fn(),
  runServiceUninstall: vi.fn(),
}));
vi.mock("./start-repair.js", () => ({ repairLoadedGatewayServiceForStart: vi.fn() }));
vi.mock("./restart-health.js", () => ({
  DEFAULT_RESTART_HEALTH_ATTEMPTS: 120,
  DEFAULT_RESTART_HEALTH_DELAY_MS: 500,
  formatGatewayRestartFailure,
  renderGatewayPortHealthDiagnostics: vi.fn(),
  renderRestartDiagnostics,
  terminateStaleGatewayPids,
  waitForGatewayHealthyListener: vi.fn(),
  waitForGatewayHealthyRestart,
  waitForGatewayHttpReadiness,
}));

const { runDaemonStart, runDaemonRestart } = await import("./lifecycle.js");

type StartPostCheck = (params: {
  fail: (message: string, hints?: string[]) => void;
  json: boolean;
  stdout: NodeJS.WritableStream;
  warnings: string[];
}) => Promise<void>;

function invokeStartPostCheck() {
  runServiceStart.mockImplementation(
    async ({ postStartCheck }: { postStartCheck?: StartPostCheck }) => {
      await postStartCheck?.({
        json: true,
        stdout: process.stdout,
        warnings: [],
        fail: (message) => {
          throw new Error(message);
        },
      });
    },
  );
}

describe("Gateway service readiness", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", undefined);
    service.readCommand.mockReset().mockResolvedValue({
      programArguments: ["openclaw", "gateway", "--port", "18789"],
      environment: {},
    });
    runServiceStart.mockReset();
    runServiceRestart.mockReset().mockImplementation(async (params: RestartParams) => {
      await params.postRestartCheck?.({
        activationAccepted: true,
        json: true,
        stdout: process.stdout,
        warnings: [],
        fail: (message) => {
          throw new Error(message);
        },
      });
      return true;
    });
    service.restart.mockReset();
    terminateStaleGatewayPids.mockReset();
    readServiceConfig.mockReset().mockResolvedValue({});
    resolveGatewayStartupTiming.mockClear();
    waitForGatewayHealthyRestart.mockReset().mockResolvedValue({ healthy: true });
    waitForGatewayHttpReadiness.mockReset().mockResolvedValue({ healthz: 200, readyz: 200 });
    renderRestartDiagnostics.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("proves Gateway health and readiness before start reports success", async () => {
    const config = { gateway: { tls: { enabled: true } } };
    readServiceConfig.mockResolvedValue(config);
    invokeStartPostCheck();

    await runDaemonStart({ json: true });

    expect(waitForGatewayHealthyRestart).toHaveBeenCalledWith(
      expect.objectContaining({
        service,
        port: 18_789,
        attempts: 90,
        delayMs: 500,
        timeoutMs: 45_000,
      }),
    );
    expect(waitForGatewayHttpReadiness).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        port: 18_789,
        attempts: 90,
        deadlineAt: expect.any(Number),
        delayMs: 500,
      }),
    );
  });

  it("reports /healthz and /readyz separately when service start remains unready", async () => {
    waitForGatewayHttpReadiness.mockResolvedValue({ healthz: 200, readyz: 503 });
    invokeStartPostCheck();

    await expect(runDaemonStart({ json: true })).rejects.toThrow(
      "waiting for /healthz and /readyz",
    );
    expect(renderRestartDiagnostics).toHaveBeenCalledOnce();
  });

  it.each([undefined, "1"])(
    "requires a Gateway health response for plain restarts (update marker=%s)",
    async (updateMarker) => {
      vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", updateMarker);

      await runDaemonRestart({ json: true });

      expect(
        requireMockCallArg(waitForGatewayHealthyRestart, "waitForGatewayHealthyRestart")
          .requirePluginHealth,
      ).toBe(updateMarker ? undefined : false);
    },
  );

  it.each([
    { json: true, updateMarker: undefined, code: 2, result: "still-starting" },
    { json: false, updateMarker: undefined, code: 2, result: "still-starting" },
    { json: true, updateMarker: "1", code: 1, result: "restart-health-failed" },
  ])(
    "reports progressing startup with the caller's response contract (json=$json, update=$updateMarker)",
    async ({ json, updateMarker, code: expectedExitCode, result }) => {
      vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", updateMarker);
      const { defaultRuntime } = await import("../../runtime.js");
      const { createDaemonActionContext } = await import("./response.js");
      const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
      const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
      const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
      const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
        throw new Error(`exit ${code}`);
      });
      runServiceRestart.mockImplementation(async (params: RestartParams) => {
        await params.postRestartCheck?.({
          ...createDaemonActionContext({ action: "restart", json }),
          activationAccepted: true,
          json,
        });
        return true;
      });
      waitForGatewayHealthyRestart.mockResolvedValue({
        healthy: false,
        staleGatewayPids: [],
        runtime: { status: "running", pid: 4242 },
        portUsage: { port: 18789, status: "free", listeners: [], hints: [] },
        waitOutcome: "still-starting",
        elapsedMs: 300_000,
        startupPhase: "startup migration",
      });

      await expect(runDaemonRestart({ json })).rejects.toThrow(`exit ${expectedExitCode}`);

      expect(exit).toHaveBeenCalledExactlyOnceWith(expectedExitCode);
      if (json) {
        expect(writeJson).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            ok: false,
            action: "restart",
            result,
            error: expect.stringMatching(
              /still starting after 300s.*startup migration.*openclaw gateway status --deep/,
            ),
          }),
        );
      } else {
        expect(error).toHaveBeenCalledWith(
          expect.stringMatching(
            /still starting after 300s.*startup migration.*openclaw gateway status --deep/,
          ),
        );
        expect(writeJson).not.toHaveBeenCalled();
      }
      expect(
        JSON.stringify([...writeJson.mock.calls, ...log.mock.calls, ...error.mock.calls]),
      ).not.toMatch(/startup hang|crash loop|restart timed out/);
      expect(service.restart).not.toHaveBeenCalled();
      expect(terminateStaleGatewayPids).not.toHaveBeenCalled();
    },
  );
});
