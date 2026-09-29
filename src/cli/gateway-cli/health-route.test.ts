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

  it("writes successful JSON without loading error-only dependencies", async () => {
    const runtime = createNonExitingRuntimeEnv();
    mocks.callGateway.mockResolvedValue({ ok: true, durationMs: 6 });

    await runGatewayHealthJsonRoute({ rpc: { json: true, timeout: "10000" } }, runtime);

    expect(mocks.callGateway).toHaveBeenCalledWith(
      "health",
      { json: true, timeout: "10000" },
      undefined,
      { defaultTimeoutMs: 10_000, sharedStateMode: "read-only" },
    );
    expect(runtime.writeJson).toHaveBeenCalledWith({ ok: true, durationMs: 6 }, 2);
    expect(mocks.loadHealth).not.toHaveBeenCalled();
    expect(mocks.loadCall).not.toHaveBeenCalled();
    expect(mocks.readNonObservingHealthConfig).not.toHaveBeenCalled();
    expect(mocks.emitReachableGatewayAuthDiagnostic).not.toHaveBeenCalled();
    expect(mocks.formatGatewayAuthErrorJson).not.toHaveBeenCalled();
    expect(mocks.formatGatewayClientRequestErrorJson).not.toHaveBeenCalled();
    expect(mocks.formatGatewayTransportErrorJson).not.toHaveBeenCalled();
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
  });

  it("leaves local config resolution failures to the root CLI renderer", async () => {
    const runtime = createNonExitingRuntimeEnv();
    const error = new Error("config unavailable");
    mocks.readNonObservingHealthConfig.mockRejectedValue(error);

    await expect(
      runGatewayHealthJsonRoute(
        { rpc: { json: true, timeout: "10000" }, localPortOverride: 19083 },
        runtime,
      ),
    ).rejects.toBe(error);

    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(runtime.writeJson).not.toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
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

  it("preserves structured Gateway health request errors", async () => {
    const runtime = createNonExitingRuntimeEnv();
    const error = new Error("health snapshot unavailable");
    mocks.callGateway.mockRejectedValue(error);
    const payload = {
      ok: false,
      error: {
        type: "gateway_request_error",
        code: "UNAVAILABLE",
        message: "health snapshot unavailable",
      },
    };
    mocks.formatGatewayClientRequestErrorJson.mockReturnValue(payload);

    await runGatewayHealthJsonRoute({ rpc: { json: true, timeout: "10000" } }, runtime);

    expect(mocks.formatGatewayClientRequestErrorJson).toHaveBeenCalledWith(error);
    expect(mocks.formatGatewayTransportErrorJson).not.toHaveBeenCalled();
    expect(runtime.writeJson).toHaveBeenCalledWith(payload, 2);
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("preserves structured auth errors when reachability is unknown", async () => {
    const runtime = createNonExitingRuntimeEnv();
    const error = new Error("gateway health requires credentials");
    mocks.callGateway.mockRejectedValue(error);
    const payload = {
      ok: false,
      error: {
        type: "gateway_credentials_required",
        message: "gateway health requires credentials",
      },
    };
    mocks.formatGatewayAuthErrorJson.mockReturnValue(payload);

    await runGatewayHealthJsonRoute({ rpc: { json: true, timeout: "10000" } }, runtime);

    expect(mocks.formatGatewayAuthErrorJson).toHaveBeenCalledWith(error);
    expect(mocks.formatGatewayClientRequestErrorJson).not.toHaveBeenCalled();
    expect(mocks.formatGatewayTransportErrorJson).not.toHaveBeenCalled();
    expect(runtime.writeJson).toHaveBeenCalledWith(payload, 2);
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
