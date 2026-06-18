import { describe, expect, it, vi } from "vitest";
import { runStartupIngressClaimSweep } from "./server-startup-ingress-sweep.js";

describe("runStartupIngressClaimSweep", () => {
  it("logs recovered count on success", async () => {
    const info = vi.fn();
    const warn = vi.fn();
    const mockSweep = vi.fn().mockImplementation(async ({ log }) => {
      log?.info?.("gateway: recovered 2 stale channel ingress claim(s) from previous session");
      return 2;
    });

    await runStartupIngressClaimSweep({
      log: { info, warn },
      deps: { recoverAllStaleChannelIngressClaims: mockSweep },
    });

    expect(mockSweep).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledWith(
      "gateway: recovered 2 stale channel ingress claim(s) from previous session",
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("skips the sweep during supervised restart handoff", async () => {
    const info = vi.fn();
    const warn = vi.fn();
    const mockSweep = vi.fn();
    const readGatewayRestartHandoffSync = vi.fn().mockReturnValue({
      kind: "gateway-supervisor-restart-handoff",
      version: 1,
      intentId: "restart-1",
      pid: 123,
      createdAt: 100,
      expiresAt: 60_100,
      source: "operator-restart",
      restartKind: "full-process",
      supervisorMode: "external",
    });

    await runStartupIngressClaimSweep({
      log: { info, warn },
      deps: {
        recoverAllStaleChannelIngressClaims: mockSweep,
        readGatewayRestartHandoffSync,
      },
    });

    expect(mockSweep).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      "gateway: skipping stale ingress claim sweep during supervised restart handoff",
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs warning and continues when sweep throws", async () => {
    const info = vi.fn();
    const warn = vi.fn();
    const mockSweep = vi.fn().mockRejectedValue(new Error("DB locked"));

    await runStartupIngressClaimSweep({
      log: { info, warn },
      deps: { recoverAllStaleChannelIngressClaims: mockSweep },
    });

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain("stale ingress claim sweep failed");
    expect(warn.mock.calls[0][0]).toContain("DB locked");
  });

  it("does not call log.info when no claims are recovered", async () => {
    const info = vi.fn();
    const warn = vi.fn();
    const mockSweep = vi.fn().mockResolvedValue(0);

    await runStartupIngressClaimSweep({
      log: { info, warn },
      deps: { recoverAllStaleChannelIngressClaims: mockSweep },
    });

    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
