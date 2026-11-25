import { beforeEach, expect, it, vi } from "vitest";

const callGatewayCli = vi.hoisted(() => vi.fn());
const refreshLegacySystemdServiceMetadata = vi.hoisted(() =>
  vi.fn<(_env: NodeJS.ProcessEnv, timeoutMs?: number) => Promise<boolean>>(async () => false),
);
const resolveGatewayServiceMutationError = vi.hoisted(() => vi.fn<() => Error | null>(() => null));
const runtimeError = vi.hoisted(() => vi.fn());
const runtimeWriteJson = vi.hoisted(() => vi.fn());

// mock-isolation: Restart requests must use fixture RPC responses, not a live Gateway.
vi.mock("../../gateway/call.js", () => ({ callGatewayCli }));

// mock-isolation: Exercise metadata-cleanup outcomes without touching host services.
vi.mock("../../daemon/systemd.js", () => ({ refreshLegacySystemdServiceMetadata }));

// mock-isolation: Supervision eligibility is supplied per case, independent of the host.
vi.mock("../../infra/gateway-supervision.js", () => ({ resolveGatewayServiceMutationError }));

// mock-isolation: Capture restart diagnostics and JSON output instead of emitting CLI output.
vi.mock("../../runtime.js", () => ({
  defaultRuntime: { error: runtimeError, log: vi.fn(), writeJson: runtimeWriteJson },
  writeRuntimeJson: (_runtime: unknown, payload: unknown) => runtimeWriteJson(payload),
}));

// mock-isolation: Safe-restart tests must not append to the operator's lifecycle audit log.
vi.mock("./lifecycle-audit.js", () => ({ appendGatewayLifecycleAudit: vi.fn() }));

beforeEach(() => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  vi.clearAllMocks();
  callGatewayCli.mockReset();
  refreshLegacySystemdServiceMetadata.mockReset().mockResolvedValue(false);
  resolveGatewayServiceMutationError.mockReset().mockReturnValue(null);
});

it("keeps skip-deferral RPC behavior when bounded metadata cleanup fails", async () => {
  const { runSafeGatewayRestart } = await import("./lifecycle-safe-restart.js");
  refreshLegacySystemdServiceMetadata.mockRejectedValueOnce(new Error("systemd cleanup timed out"));
  callGatewayCli.mockResolvedValueOnce({
    status: "scheduled",
    preflight: {
      blockers: [{ kind: "pending-replies", count: 2, message: "2 pending reply(ies)" }],
      summary: "restart deferred: 2 pending reply(ies)",
    },
    restart: { pid: 123 },
  });

  await expect(runSafeGatewayRestart({ json: true, safe: true, skipDeferral: true })).resolves.toBe(
    true,
  );

  expect(callGatewayCli).toHaveBeenCalledWith({
    method: "gateway.restart.request",
    params: { reason: "gateway.restart.safe", skipDeferral: true },
    timeoutMs: 10_000,
  });
  expect(refreshLegacySystemdServiceMetadata).toHaveBeenCalledWith(process.env, 5_000);
  expect(runtimeError).toHaveBeenCalledWith(expect.stringContaining("systemd cleanup timed out"));
  expect(runtimeWriteJson).toHaveBeenCalledWith(
    expect.objectContaining({
      message:
        "safe restart requested; gateway bypassing active-work deferral; " +
        "shutdown may still wait for pending replies to drain",
      result: "scheduled",
    }),
  );
});

it("keeps the RPC restart while skipping ineligible service mutation", async () => {
  resolveGatewayServiceMutationError.mockReturnValueOnce(
    new Error("gateway lifecycle is managed by an external supervisor"),
  );
  const { runSafeGatewayRestart } = await import("./lifecycle-safe-restart.js");
  callGatewayCli.mockResolvedValueOnce({
    status: "scheduled",
    preflight: { blockers: [], summary: "safe to restart now" },
    restart: { pid: 123 },
  });

  await expect(runSafeGatewayRestart({ json: true, safe: true })).resolves.toBe(true);

  expect(refreshLegacySystemdServiceMetadata).not.toHaveBeenCalled();
  expect(callGatewayCli).toHaveBeenCalledOnce();
  expect(runtimeError).toHaveBeenCalledWith(expect.stringContaining("external supervisor"));
});
