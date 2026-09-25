// Gateway health route tests cover the machine-readable fast path and its error contract.
import { describe, expect, it, vi } from "vitest";
import { createNonExitingRuntimeEnv } from "../../test-utils/plugin-runtime-env.js";
import { runGatewayHealthJsonRoute } from "./health-route.js";

describe("runGatewayHealthJsonRoute", () => {
  it("writes successful JSON without loading error-only dependencies", async () => {
    const runtime = createNonExitingRuntimeEnv();
    const callGateway = vi.fn(async () => ({ ok: true, durationMs: 6 }));
    const readNonObservingHealthConfig = vi.fn(async () => ({}));
    const emitReachableGatewayAuthDiagnostic = vi.fn(async () => false);
    const formatGatewayAuthErrorJson = vi.fn();
    const formatGatewayClientRequestErrorJson = vi.fn();
    const formatGatewayTransportErrorJson = vi.fn();

    await runGatewayHealthJsonRoute(
      {
        rpc: { json: true, timeout: "10000" },
      },
      runtime,
      {
        callGateway,
        readNonObservingHealthConfig,
        emitReachableGatewayAuthDiagnostic: emitReachableGatewayAuthDiagnostic as never,
        formatGatewayAuthErrorJson: formatGatewayAuthErrorJson as never,
        formatGatewayClientRequestErrorJson: formatGatewayClientRequestErrorJson as never,
        formatGatewayTransportErrorJson: formatGatewayTransportErrorJson as never,
      },
    );

    expect(callGateway).toHaveBeenCalledWith(
      "health",
      { json: true, timeout: "10000" },
      undefined,
      { defaultTimeoutMs: 10_000, sharedStateMode: "read-only" },
    );
    expect(runtime.writeJson).toHaveBeenCalledWith({ ok: true, durationMs: 6 }, 2);
    expect(readNonObservingHealthConfig).not.toHaveBeenCalled();
    expect(emitReachableGatewayAuthDiagnostic).not.toHaveBeenCalled();
    expect(formatGatewayAuthErrorJson).not.toHaveBeenCalled();
    expect(formatGatewayClientRequestErrorJson).not.toHaveBeenCalled();
    expect(formatGatewayTransportErrorJson).not.toHaveBeenCalled();
  });

  it("projects a local port into the routed config", async () => {
    const runtime = createNonExitingRuntimeEnv();
    const callGateway = vi.fn(async () => ({ ok: true }));
    const readNonObservingHealthConfig = vi.fn(async () => ({
      gateway: { auth: { mode: "token" as const } },
    }));

    await runGatewayHealthJsonRoute(
      {
        rpc: { json: true, timeout: "10000" },
        localPortOverride: 19083,
      },
      runtime,
      { callGateway, readNonObservingHealthConfig },
    );

    expect(callGateway).toHaveBeenCalledWith(
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
    const callGateway = vi.fn();

    await expect(
      runGatewayHealthJsonRoute(
        {
          rpc: { json: true, timeout: "10000" },
          localPortOverride: 19083,
        },
        runtime,
        {
          callGateway,
          readNonObservingHealthConfig: vi.fn(async () => {
            throw error;
          }),
        },
      ),
    ).rejects.toBe(error);

    expect(callGateway).not.toHaveBeenCalled();
    expect(runtime.writeJson).not.toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("preserves structured transport errors", async () => {
    const runtime = createNonExitingRuntimeEnv();
    const error = new Error("gateway unavailable");
    const callGateway = vi.fn(async () => {
      throw error;
    });
    const payload = { ok: false, error: { type: "gateway_transport_error" } };

    await runGatewayHealthJsonRoute({ rpc: { json: true, timeout: "10000" } }, runtime, {
      callGateway,
      readNonObservingHealthConfig: async () => ({}),
      emitReachableGatewayAuthDiagnostic: vi.fn(async () => false) as never,
      formatGatewayAuthErrorJson: vi.fn(() => null) as never,
      formatGatewayClientRequestErrorJson: vi.fn(() => null) as never,
      formatGatewayTransportErrorJson: vi.fn(() => payload) as never,
    });

    expect(runtime.writeJson).toHaveBeenCalledWith(payload, 2);
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("preserves structured Gateway health request errors", async () => {
    const runtime = createNonExitingRuntimeEnv();
    const error = new Error("health snapshot unavailable");
    const callGateway = vi.fn(async () => {
      throw error;
    });
    const payload = {
      ok: false,
      error: {
        type: "gateway_request_error",
        code: "UNAVAILABLE",
        message: "health snapshot unavailable",
      },
    };
    const formatGatewayClientRequestErrorJson = vi.fn(() => payload);
    const formatGatewayTransportErrorJson = vi.fn();

    await runGatewayHealthJsonRoute({ rpc: { json: true, timeout: "10000" } }, runtime, {
      callGateway,
      readNonObservingHealthConfig: async () => ({}),
      emitReachableGatewayAuthDiagnostic: vi.fn(async () => false) as never,
      formatGatewayAuthErrorJson: vi.fn(() => null) as never,
      formatGatewayClientRequestErrorJson: formatGatewayClientRequestErrorJson as never,
      formatGatewayTransportErrorJson: formatGatewayTransportErrorJson as never,
    });

    expect(formatGatewayClientRequestErrorJson).toHaveBeenCalledWith(error);
    expect(formatGatewayTransportErrorJson).not.toHaveBeenCalled();
    expect(runtime.writeJson).toHaveBeenCalledWith(payload, 2);
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("preserves structured auth errors when reachability is unknown", async () => {
    const runtime = createNonExitingRuntimeEnv();
    const error = new Error("gateway health requires credentials");
    const callGateway = vi.fn(async () => {
      throw error;
    });
    const payload = {
      ok: false,
      error: {
        type: "gateway_credentials_required",
        message: "gateway health requires credentials",
      },
    };
    const formatGatewayAuthErrorJson = vi.fn(() => payload);
    const formatGatewayClientRequestErrorJson = vi.fn(() => null);
    const formatGatewayTransportErrorJson = vi.fn(() => null);

    await runGatewayHealthJsonRoute({ rpc: { json: true, timeout: "10000" } }, runtime, {
      callGateway,
      readNonObservingHealthConfig: async () => ({}),
      emitReachableGatewayAuthDiagnostic: vi.fn(async () => false) as never,
      formatGatewayAuthErrorJson: formatGatewayAuthErrorJson as never,
      formatGatewayClientRequestErrorJson: formatGatewayClientRequestErrorJson as never,
      formatGatewayTransportErrorJson: formatGatewayTransportErrorJson as never,
    });

    expect(formatGatewayAuthErrorJson).toHaveBeenCalledWith(error);
    expect(formatGatewayClientRequestErrorJson).not.toHaveBeenCalled();
    expect(formatGatewayTransportErrorJson).not.toHaveBeenCalled();
    expect(runtime.writeJson).toHaveBeenCalledWith(payload, 2);
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
