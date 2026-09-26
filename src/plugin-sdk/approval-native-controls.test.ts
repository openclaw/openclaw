import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createNativeApprovalControlRegistry } from "./approval-runtime.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("native approval controls", () => {
  it.each([
    { releaseClaimOnLookupExpiry: false, expiry: "lookup", next: "in-flight" },
    { releaseClaimOnLookupExpiry: true, expiry: "lookup", next: "settled" },
    { releaseClaimOnLookupExpiry: false, expiry: "sweep", next: "settled" },
  ] as const)(
    "preserves claim cleanup for $expiry with releaseClaimOnLookupExpiry=$releaseClaimOnLookupExpiry",
    async ({ releaseClaimOnLookupExpiry, expiry, next }) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const controls = createNativeApprovalControlRegistry({ releaseClaimOnLookupExpiry });
      const finish = createDeferred();
      controls.register({ token: "rebound", expiresAtMs: 2_000 });
      const pending = controls.settle("rebound", () => finish.promise);
      try {
        vi.setSystemTime(2_000);
        if (expiry === "sweep") {
          controls.pruneExpired(2_000);
        } else {
          expect(controls.get("rebound")).toBeNull();
        }
        controls.register({ token: "rebound", expiresAtMs: 3_000 });
        const result = await controls.settle("rebound", async () => "replacement");
        expect(result.kind).toBe(next);
      } finally {
        finish.resolve();
        await pending;
      }
    },
  );

  it("keeps plugin registries independent even when tokens coincide", async () => {
    type Binding = { token: string; expiresAtMs: number; approvalId: string };
    const first = createNativeApprovalControlRegistry<Binding>({
      releaseClaimOnLookupExpiry: true,
    });
    const second = createNativeApprovalControlRegistry<Binding>({
      releaseClaimOnLookupExpiry: false,
    });
    const binding = { token: "same-token", expiresAtMs: Date.now() + 60_000 };
    first.register({ ...binding, approvalId: "first" });
    second.register({ ...binding, approvalId: "second" });

    await expect(
      first.settle(binding.token, async (entry) => entry.approvalId),
    ).resolves.toMatchObject({
      kind: "settled",
      result: "first",
    });
    expect(second.get(binding.token)?.approvalId).toBe("second");
    await expect(
      second.settle(binding.token, async (entry) => entry.approvalId),
    ).resolves.toMatchObject({
      kind: "settled",
      result: "second",
    });
  });
  // A refusal is not a missing approval: it answers who may decide, so the control survives it
  // and the error reaches the channel, while a missing approval retires the control.
  type SettleBinding = { token: string; expiresAtMs: number; approvalId: string };
  const failingSettle = (details: Record<string, string>, gatewayCode: string) => {
    const registry = createNativeApprovalControlRegistry<SettleBinding>({
      releaseClaimOnLookupExpiry: false,
    });
    const binding = { token: "tok", expiresAtMs: Date.now() + 60_000, approvalId: "a1" };
    registry.register(binding);
    const failure = Object.assign(new Error("resolve failed"), { gatewayCode, details });
    const settled = registry.settle(binding.token, async () => {
      throw failure;
    });
    return { registry, binding, failure, settled };
  };

  it("keeps a refused control and leaves it for the listed approver's next tap", async () => {
    const { registry, binding, failure, settled } = failingSettle(
      { code: "APPROVAL_AUTHORITY_REQUIRED" },
      "FORBIDDEN",
    );
    await expect(settled).rejects.toBe(failure);
    expect(registry.get(binding.token)).toBeTruthy();
    await expect(registry.settle(binding.token, async () => "decided")).resolves.toMatchObject({
      kind: "settled",
      result: "decided",
    });
  });

  it("retires a control whose approval is gone", async () => {
    const { registry, binding, settled } = failingSettle(
      { reason: "APPROVAL_NOT_FOUND" },
      "INVALID_REQUEST",
    );
    await expect(settled).resolves.toMatchObject({ kind: "not-found" });
    expect(registry.get(binding.token)).toBeNull();
    await expect(registry.settle(binding.token, async () => "decided")).resolves.toMatchObject({
      kind: "missing",
    });
  });
});
