import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RestartParams } from "./lifecycle.test-helpers.js";

const runServiceRestart = vi.hoisted(() => vi.fn());
const waitForGatewayHealthyRestart = vi.hoisted(() => vi.fn());
const service = vi.hoisted(() => ({}));

vi.mock("../../daemon/service.js", () => ({ resolveGatewayService: () => service }));
vi.mock("../../infra/gateway-supervision.js", () => ({
  assertGatewayServiceMutationAllowed: vi.fn(),
  formatExternalSupervisorActionRequired: vi.fn(),
  isGatewayExternallySupervised: () => false,
  resolveGatewayServiceMutationError: vi.fn(),
}));
vi.mock("../../infra/gateway-lock.js", () => ({
  readActiveGatewayLockPort: async () => undefined,
}));
vi.mock("./lifecycle-context.js", () => ({
  resolveGatewayConfigPorts: async () => ({ explicit: undefined, fallback: 18789 }),
  resolveGatewayLifecycleContext: async () => ({ port: 18789, env: process.env }),
}));
vi.mock("./lifecycle-core.js", () => ({
  runServiceRestart,
  runServiceStop: vi.fn(),
  runServiceUninstall: vi.fn(),
}));
vi.mock("./restart-health.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./restart-health.js")>()),
  waitForGatewayHealthyRestart,
}));

const { runDaemonRestart } = await import("./lifecycle.js");

describe("Gateway restart plugin readiness result", () => {
  beforeEach(() => {
    runServiceRestart.mockReset();
    waitForGatewayHealthyRestart.mockReset();
  });

  it.each([true, false])(
    "preserves accepted activation (%s) when plugin readiness fails",
    async (activationAccepted) => {
      const fail = vi.fn<
        ReturnType<typeof import("./response.js").createDaemonActionContext>["fail"]
      >((message) => {
        throw new Error(message);
      });
      runServiceRestart.mockImplementation(async (params: RestartParams) => {
        await params.postRestartCheck?.({
          activationAccepted,
          json: true,
          stdout: process.stdout,
          warnings: [],
          fail,
        });
        return true;
      });
      waitForGatewayHealthyRestart.mockResolvedValue({
        healthy: false,
        staleGatewayPids: [],
        runtime: { status: "running", pid: 4200 },
        portUsage: { port: 18789, status: "busy", listeners: [{ pid: 4200 }], hints: [] },
        waitOutcome: "plugin-unavailable",
        unavailablePlugins: [
          {
            id: "example",
            reason: "missing-openclaw-peer-link",
            detail: "Plugin peer link is missing",
          },
        ],
      });

      await expect(runDaemonRestart({ json: true })).rejects.toThrow(
        "Gateway remains running in degraded mode",
      );
      expect(fail).toHaveBeenCalledOnce();
      expect(fail.mock.calls[0]?.[2]).toBe(
        activationAccepted ? "restart-health-failed" : undefined,
      );
    },
  );
});
