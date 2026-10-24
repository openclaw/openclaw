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
    vi.doMock("../../commands/health.js", async (importOriginal) => {
      mocks.loadHealth();
      return {
        ...(await importOriginal<typeof import("../../commands/health.js")>()),
        readNonObservingHealthConfig: mocks.readNonObservingHealthConfig,
        emitReachableGatewayAuthDiagnostic: mocks.emitReachableGatewayAuthDiagnostic,
      };
    });
    vi.doMock("../../gateway/call.js", async (importOriginal) => {
      mocks.loadCall();
      return {
        ...(await importOriginal<typeof import("../../gateway/call.js")>()),
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
    expect(mocks.emitReachableGatewayAuthDiagnostic).not.toHaveBeenCalled();
  });

  it.each(["auth", "request", "transport"] as const)(
    "preserves structured %s errors",
    async (kind) => {
      const runtime = createNonExitingRuntimeEnv();
      mocks.callGateway.mockRejectedValue(new Error("gateway unavailable"));
      const payload = { ok: false, error: { type: `gateway_${kind}_error` } };
      const formatters = {
        auth: mocks.formatGatewayAuthErrorJson,
        request: mocks.formatGatewayClientRequestErrorJson,
        transport: mocks.formatGatewayTransportErrorJson,
      };
      formatters[kind].mockReturnValue(payload);

      await runGatewayHealthJsonRoute({ rpc: { json: true, timeout: "10000" } }, runtime);

      expect(runtime.writeJson).toHaveBeenCalledExactlyOnceWith(payload, 2);
      expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
      expect(vi.mocked(runtime.writeJson).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(runtime.exit).mock.invocationCallOrder[0]!,
      );
    },
  );

  it("rethrows unknown failures without emitting a replacement", async () => {
    const runtime = createNonExitingRuntimeEnv();
    const error = new Error("unclassified failure");
    mocks.callGateway.mockRejectedValue(error);
    await expect(runGatewayHealthJsonRoute({ rpc: { json: true } }, runtime)).rejects.toBe(error);
    expect(runtime.writeJson).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("keeps a successful default route free of health config and error presentation", async () => {
    const runtime = createNonExitingRuntimeEnv();
    const rpc = { json: true, timeout: "10000" };
    mocks.callGateway.mockResolvedValue({ ok: true });

    await runGatewayHealthJsonRoute({ rpc }, runtime);

    expect(mocks.callGateway.mock.calls[0]?.[1]).toBe(rpc);
    expect(runtime.writeJson).toHaveBeenCalledWith({ ok: true }, 2);
    expect(mocks.loadHealth).not.toHaveBeenCalled();
    expect(mocks.readNonObservingHealthConfig).not.toHaveBeenCalled();
    expect(mocks.loadCall).not.toHaveBeenCalled();
  });
});
