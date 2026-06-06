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
