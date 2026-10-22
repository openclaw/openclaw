import { describe, expect, it, vi } from "vitest";
import type { NativeSubagentRuntime } from "../../plugins/runtime/types-native-subagent.js";
import { resolveCommandNativeSubagentEligibility } from "./request-native-subagent.js";

describe("command native subagent eligibility", () => {
  function fixture() {
    const assertOwnerCurrent = vi.fn();
    const runtime: NativeSubagentRuntime = { spawn: vi.fn(), collect: vi.fn() };
    return {
      command: { requireAuth: true, runtimeCapabilities: ["subagents"] },
      ingressEligible: true,
      assertCurrent: vi.fn(),
      authorizeRequester: vi.fn(async () => ({
        isAuthorizedSender: true,
        senderIsOwner: true,
        assertOwnerCurrent,
      })),
      prepare: vi.fn(async () => runtime),
      assertOwnerCurrent,
      runtime,
    };
  }

  it("reauthorizes each ingress-owned run without a message context", async () => {
    const params = fixture();
    await expect(resolveCommandNativeSubagentEligibility(params)).resolves.toBe(params.runtime);
    params.authorizeRequester.mockResolvedValueOnce({
      isAuthorizedSender: false,
      senderIsOwner: false,
      assertOwnerCurrent: params.assertOwnerCurrent,
    });
    await expect(resolveCommandNativeSubagentEligibility(params)).resolves.toBeUndefined();
    expect(params.authorizeRequester).toHaveBeenCalledTimes(2);
    expect(params.prepare).toHaveBeenCalledTimes(1);
  });

  it.for(["ingress", "authentication", "declaration"])(
    "does not prepare an ineligible %s",
    async (missing) => {
      const params = fixture();
      if (missing === "ingress") {
        params.ingressEligible = false;
      }
      if (missing === "authentication") {
        params.command.requireAuth = false;
      }
      if (missing === "declaration") {
        params.command.runtimeCapabilities = [];
      }
      await expect(resolveCommandNativeSubagentEligibility(params)).resolves.toBeUndefined();
      expect(params.authorizeRequester).not.toHaveBeenCalled();
      expect(params.prepare).not.toHaveBeenCalled();
    },
  );

  it("leaves the optional capability absent when preparation is unavailable", async () => {
    const params = fixture();
    params.prepare.mockRejectedValueOnce(new Error("recorder unavailable"));
    await expect(resolveCommandNativeSubagentEligibility(params)).resolves.toBeUndefined();
  });

  it("does not hide authority revocation during preparation", async () => {
    const params = fixture();
    params.prepare.mockImplementationOnce(async () => {
      params.assertOwnerCurrent.mockImplementation(() => {
        throw new Error("owner revoked");
      });
      throw new Error("preparation interrupted");
    });
    await expect(resolveCommandNativeSubagentEligibility(params)).rejects.toThrow("owner revoked");
  });
});
