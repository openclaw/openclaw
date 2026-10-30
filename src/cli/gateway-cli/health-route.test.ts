import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createNonExitingRuntimeEnv } from "../../test-utils/plugin-runtime-env.js";
import { runGatewayHealthJsonRoute } from "./health-route.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  readNonObservingHealthConfig: vi.fn(),
  emitReachableGatewayAuthDiagnostic: vi.fn(),
  loadCall: vi.fn(),
  errors: {
    formatGatewayAuthErrorJson: vi.fn(),
    formatGatewayClientRequestErrorJson: vi.fn(),
    formatGatewayTransportErrorJson: vi.fn(),
  },
}));

let runtime: ReturnType<typeof createNonExitingRuntimeEnv>;
const run = (localPortOverride?: number) =>
  runGatewayHealthJsonRoute({ rpc: { json: true }, localPortOverride }, runtime);
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  runtime = createNonExitingRuntimeEnv();
  mocks.readNonObservingHealthConfig.mockResolvedValue({});
  mocks.emitReachableGatewayAuthDiagnostic.mockResolvedValue(false);
  vi.doMock("../gateway-rpc.js", () => ({ callGatewayFromCliWithTransport: mocks.callGateway }));
  vi.doMock("../../commands/health.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../commands/health.js")>()),
    readNonObservingHealthConfig: mocks.readNonObservingHealthConfig,
    emitReachableGatewayAuthDiagnostic: mocks.emitReachableGatewayAuthDiagnostic,
  }));
  vi.doMock("../../gateway/call.js", async (importOriginal) => {
    mocks.loadCall();
    return { ...(await importOriginal<typeof import("../../gateway/call.js")>()), ...mocks.errors };
  });
});
afterEach(() => {
  vi.doUnmock("../gateway-rpc.js");
  vi.doUnmock("../../commands/health.js");
  vi.doUnmock("../../gateway/call.js");
});

it("projects a local port into the routed config", async () => {
  mocks.callGateway.mockResolvedValue({ ok: true });
  mocks.readNonObservingHealthConfig.mockResolvedValue({ gateway: { auth: { mode: "token" } } });
  await run(19083);
  expect(mocks.callGateway.mock.calls[0]?.[1]).toEqual(
    expect.objectContaining({
      localPortOverride: 19083,
      config: { gateway: { auth: { mode: "token" }, mode: "local", port: 19083 } },
    }),
  );
  expect(runtime.writeJson).toHaveBeenCalledWith({ ok: true }, 2);
  expect(mocks.emitReachableGatewayAuthDiagnostic).not.toHaveBeenCalled();
});

it("keeps the default route free of health config and error presentation", async () => {
  mocks.callGateway.mockResolvedValue({ ok: true });
  await run();
  expect(runtime.writeJson).toHaveBeenCalledWith({ ok: true }, 2);
  expect(mocks.readNonObservingHealthConfig).not.toHaveBeenCalled();
  expect(mocks.loadCall).not.toHaveBeenCalled();
});

it.each(Object.entries(mocks.errors))("preserves structured %s errors", async (kind, formatter) => {
  mocks.callGateway.mockRejectedValue(new Error("gateway unavailable"));
  const payload = { ok: false, error: { type: `gateway_${kind}_error` } };
  formatter.mockReturnValue(payload);
  await run();
  expect(runtime.writeJson).toHaveBeenCalledExactlyOnceWith(payload, 2);
  expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(vi.mocked(runtime.writeJson).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(runtime.exit).mock.invocationCallOrder[0]!,
  );
});

it("rethrows unknown failures without emitting a replacement", async () => {
  const error = new Error("unclassified failure");
  mocks.callGateway.mockRejectedValue(error);
  await expect(run()).rejects.toBe(error);
  expect(runtime.writeJson).not.toHaveBeenCalled();
  expect(runtime.exit).not.toHaveBeenCalled();
});
