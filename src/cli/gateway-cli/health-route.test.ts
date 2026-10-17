// Gateway health route tests cover the machine-readable fast path and its error contract.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNonExitingRuntimeEnv } from "../../test-utils/plugin-runtime-env.js";
import { runGatewayHealthJsonRoute } from "./health-route.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  readNonObservingHealthConfig: vi.fn(),
  emitReachableGatewayAuthDiagnostic: vi.fn(),
  formatGatewayAuthErrorJson: vi.fn(),
  formatGatewayClientRequestErrorJson: vi.fn(),
  formatGatewayTransportErrorJson: vi.fn(),
  loadHealth: vi.fn(),
  loadCall: vi.fn(),
}));

describe("runGatewayHealthJsonRoute", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    mocks.readNonObservingHealthConfig.mockResolvedValue({});
    mocks.emitReachableGatewayAuthDiagnostic.mockResolvedValue(false);
    vi.doMock("../gateway-rpc.js", () => ({ callGatewayFromCliWithTransport: mocks.callGateway }));
    vi.doMock("../../commands/health.js", () => {
      mocks.loadHealth();
      return {
        readNonObservingHealthConfig: mocks.readNonObservingHealthConfig,
        emitReachableGatewayAuthDiagnostic: mocks.emitReachableGatewayAuthDiagnostic,
      };
    });
    vi.doMock("../../gateway/call.js", () => {
      mocks.loadCall();
      return {
        formatGatewayAuthErrorJson: mocks.formatGatewayAuthErrorJson,
        formatGatewayClientRequestErrorJson: mocks.formatGatewayClientRequestErrorJson,
        formatGatewayTransportErrorJson: mocks.formatGatewayTransportErrorJson,
      };
    });
  });
  afterEach(() => {
    vi.doUnmock("../gateway-rpc.js");
    vi.doUnmock("../../commands/health.js");
    vi.doUnmock("../../gateway/call.js");
  });

  it("projects a local port into the routed config", async () => {
    const runtime = createNonExitingRuntimeEnv();
    mocks.callGateway.mockResolvedValue({ ok: true });
    mocks.readNonObservingHealthConfig.mockResolvedValue({ gateway: { auth: { mode: "token" } } });

    await runGatewayHealthJsonRoute(
      { rpc: { json: true, timeout: "10000" }, localPortOverride: 19083 },
      runtime,
    );

    expect(mocks.callGateway).toHaveBeenCalledWith(
      "health",
      expect.objectContaining({
        localPortOverride: 19083,
        config: {
          gateway: { auth: { mode: "token" }, mode: "local", port: 19083 },
        },
      }),
      undefined,
      { defaultTimeoutMs: 10_000, sharedStateMode: "read-only" },
    );
    expect(runtime.writeJson).toHaveBeenCalledWith({ ok: true }, 2);
    expect(mocks.loadCall).not.toHaveBeenCalled();
    expect(mocks.emitReachableGatewayAuthDiagnostic).not.toHaveBeenCalled();
  });

  it("preserves structured transport errors", async () => {
    const runtime = createNonExitingRuntimeEnv();
    mocks.callGateway.mockRejectedValue(new Error("gateway unavailable"));
    const payload = { ok: false, error: { type: "gateway_transport_error" } };
    mocks.formatGatewayTransportErrorJson.mockReturnValue(payload);

    await runGatewayHealthJsonRoute({ rpc: { json: true, timeout: "10000" } }, runtime);

    expect(runtime.writeJson).toHaveBeenCalledWith(payload, 2);
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
