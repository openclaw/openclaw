import { describe, expect, it, vi } from "vitest";
import {
  verifyChannelMessageAdapterCapabilityProofs,
  verifyChannelMessageLiveCapabilityAdapterProofs,
  verifyChannelMessageLiveFinalizerProofs,
  verifyChannelMessageReceiveAckPolicyAdapterProofs,
  verifyDurableFinalCapabilityProofs,
} from "./contracts.js";
import { durableFinalDeliveryCapabilities } from "./types.js";

function expectProofs(
  results: readonly { status: string }[],
  proofs: Record<string, ReturnType<typeof vi.fn>>,
  total: number,
  key = "capability",
): void {
  expect(results.filter((result) => result.status === "verified")).toEqual(
    Object.keys(proofs).map((name) => ({ [key]: name, status: "verified" })),
  );
  expect(results).toHaveLength(total);
  expect(
    results.every((result) => result.status === "verified" || result.status === "not_declared"),
  ).toBe(true);
  for (const proof of Object.values(proofs)) {
    expect(proof).toHaveBeenCalledTimes(1);
  }
}

describe("durable final capability contracts", () => {
  it("fails when a declared durable-final capability has no proof", async () => {
    await expect(
      verifyDurableFinalCapabilityProofs({
        adapterName: "demo",
        capabilities: { text: true, nativeQuote: true },
        proofs: { text: () => {} },
      }),
    ).rejects.toThrow(
      'demo declares durable final capability "nativeQuote" without a contract proof',
    );
  });

  it("runs proofs from channel message adapter declarations", async () => {
    const proofs = { text: vi.fn(), media: vi.fn() };
    const results = await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "demo",
      adapter: { durableFinal: { capabilities: { text: true, media: true } } },
      proofs,
    });
    expectProofs(results, proofs, durableFinalDeliveryCapabilities.length);
  });

  it("runs live preview finalizer proofs from channel message adapter declarations", async () => {
    const proofs = { finalEdit: vi.fn(), normalFallback: vi.fn() };
    const results = await verifyChannelMessageLiveFinalizerProofs({
      adapterName: "demo",
      adapter: { live: { finalizer: { capabilities: { finalEdit: true, normalFallback: true } } } },
      proofs,
    });
    expectProofs(results, proofs, 5);
  });

  it("runs live capability proofs from channel message adapter declarations", async () => {
    const proofs = { draftPreview: vi.fn(), previewFinalization: vi.fn() };
    const results = await verifyChannelMessageLiveCapabilityAdapterProofs({
      adapterName: "demo",
      adapter: { live: { capabilities: { draftPreview: true, previewFinalization: true } } },
      proofs,
    });
    expectProofs(results, proofs, 5);
  });

  it("runs receive ack policy proofs from channel message adapter declarations", async () => {
    const proofs = { after_receive_record: vi.fn(), after_agent_dispatch: vi.fn() };
    const results = await verifyChannelMessageReceiveAckPolicyAdapterProofs({
      adapterName: "demo",
      adapter: {
        receive: {
          defaultAckPolicy: "after_agent_dispatch",
          supportedAckPolicies: ["after_receive_record", "after_agent_dispatch"],
        },
      },
      proofs,
    });
    expectProofs(results, proofs, 4, "policy");
  });
});
