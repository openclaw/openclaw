// Status JSON command tests cover runtime invocation and structured status JSON output.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runStatusJsonCommand } from "./status-json-command.ts";
import { createStatusGatewayProbeBudget } from "./status.gateway-probe-budget.js";
import { createStatusScanResultFixture } from "./status.test-support.ts";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({
  scanStatusJsonFast: vi.fn(),
  writeRuntimeJson: vi.fn(),
  resolveStatusJsonOutput: vi.fn(async (input) => ({ built: true, input })),
}));

// mock-isolation: exercise JSON policy without reading config, probing the Gateway, or loading plugins.
vi.mock("./status.scan.fast-json.js", () => ({
  scanStatusJsonFast: mocks.scanStatusJsonFast,
}));

vi.mock("../runtime.js", () => ({
  writeRuntimeJson: mocks.writeRuntimeJson,
}));

vi.mock("./status-json-runtime.ts", () => ({
  resolveStatusJsonOutput: mocks.resolveStatusJsonOutput,
}));

describe("runStatusJsonCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(performance, "now").mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shares the fast-json scan and output flow", async () => {
    const runtime = createTestRuntime();
    const scan = createStatusScanResultFixture({
      cfg: { gateway: {} },
      sourceConfig: { gateway: {} },
      summary: { ok: true } as never,
      osSummary: { platform: "linux" } as never,
      memory: null,
      tailscaleMode: "off",
      tailscaleDns: null,
      tailscaleHttpsUrl: null,
      gatewayMode: "local" as const,
      gatewayConnection: {
        url: "ws://127.0.0.1:18789",
        urlSource: "config",
        message: "Gateway target: ws://127.0.0.1:18789",
      },
      remoteUrlMissing: false,
      gatewayReachable: true,
      gatewayProbe: null,
      gatewayProbeAuth: { token: "tok" },
      gatewaySelf: null,
      gatewayProbeAuthWarning: undefined,
      secretDiagnostics: [],
    });
    mocks.scanStatusJsonFast.mockResolvedValue(scan);

    await runStatusJsonCommand({
      opts: {
        ...createStatusGatewayProbeBudget(1234),
        deep: true,
        usage: true,
        agent: "beta",
        all: true,
      },
      runtime,
    });

    expect(mocks.scanStatusJsonFast).toHaveBeenCalledWith(
      { timeoutMs: 1234, gatewayProbeDeadlineMs: 1234, all: true },
      runtime,
    );
    expect(mocks.resolveStatusJsonOutput).toHaveBeenCalledWith({
      scan,
      opts: {
        ...createStatusGatewayProbeBudget(1234),
        deep: true,
        usage: true,
        agent: "beta",
        all: true,
      },
      includeSecurityAudit: true,
      includePluginCompatibility: true,
      suppressHealthErrors: true,
    });
    expect(mocks.writeRuntimeJson).toHaveBeenCalledWith(runtime, {
      built: true,
      input: {
        scan,
        opts: {
          ...createStatusGatewayProbeBudget(1234),
          deep: true,
          usage: true,
          agent: "beta",
          all: true,
        },
        includeSecurityAudit: true,
        includePluginCompatibility: true,
        suppressHealthErrors: true,
      },
    });
  });

  it("rejects --agent when usage is not requested", async () => {
    const runtime = createTestRuntime();

    await expect(
      runStatusJsonCommand({
        opts: { ...createStatusGatewayProbeBudget(), agent: "beta" },
        runtime,
      }),
    ).rejects.toThrow("--agent is only valid with --usage");
    expect(mocks.scanStatusJsonFast).not.toHaveBeenCalled();
  });
});
