// Approval tests cover channel plugin approval request formatting and dispatch.
import { describe, expect, it, vi } from "vitest";
import {
  resolveChannelApprovalAdapter,
  resolveChannelApprovalCapability,
  resolveChannelApprovalTextMode,
} from "./approvals.js";

function createNativeRuntimeStub() {
  return {
    availability: {
      isConfigured: vi.fn(),
      shouldHandle: vi.fn(),
    },
    presentation: {
      buildPendingPayload: vi.fn(),
      buildResolvedResult: vi.fn(),
      buildExpiredResult: vi.fn(),
    },
    transport: {
      prepareTarget: vi.fn(),
      deliverPending: vi.fn(),
    },
  };
}

describe("resolveChannelApprovalCapability", () => {
  it("returns undefined when approvalCapability is absent", () => {
    expect(resolveChannelApprovalCapability({})).toBeUndefined();
  });

  it("returns approvalCapability as the canonical approval contract", () => {
    const capabilityAuth = vi.fn();
    const capabilityAvailability = vi.fn();
    const capabilityNativeRuntime = createNativeRuntimeStub();
    const delivery = { hasConfiguredDmRoute: vi.fn() };

    expect(
      resolveChannelApprovalCapability({
        approvalCapability: {
          authorizeActorAction: capabilityAuth,
          getActionAvailabilityState: capabilityAvailability,
          delivery,
          nativeRuntime: capabilityNativeRuntime,
        },
      }),
    ).toEqual({
      authorizeActorAction: capabilityAuth,
      getActionAvailabilityState: capabilityAvailability,
      delivery,
      nativeRuntime: capabilityNativeRuntime,
      render: undefined,
      native: undefined,
    });
  });
});

describe("resolveChannelApprovalTextMode", () => {
  it("defaults to plaintext when nothing is declared", () => {
    expect(resolveChannelApprovalTextMode({})).toBe("plaintext");
    expect(resolveChannelApprovalTextMode({ approvalCapability: {} })).toBe("plaintext");
  });

  it("returns the declared mode", () => {
    expect(
      resolveChannelApprovalTextMode({ approvalCapability: { approvalText: "markdown" } }),
    ).toBe("markdown");
  });

  it("resolves for auth-only capabilities that project no adapter", () => {
    // Regression guard: resolveChannelApprovalAdapter returns undefined for
    // auth-only capabilities and copies a fixed field list, so reading the mode
    // through that projection would fail on exactly the channels the default
    // exists to protect.
    const plugin = {
      approvalCapability: {
        authorizeActorAction: () => ({ authorized: true }),
        approvalText: "markdown" as const,
      },
    };
    expect(resolveChannelApprovalAdapter(plugin)).toBeUndefined();
    expect(resolveChannelApprovalTextMode(plugin)).toBe("markdown");
  });
});

describe("resolveChannelApprovalAdapter", () => {
  it("returns only delivery/runtime surfaces from approvalCapability", () => {
    const delivery = { hasConfiguredDmRoute: vi.fn() };
    const nativeRuntime = createNativeRuntimeStub();
    const describeExecApprovalSetup = vi.fn();
    const describePluginApprovalSetup = vi.fn();

    expect(
      resolveChannelApprovalAdapter({
        approvalCapability: {
          describeExecApprovalSetup,
          describePluginApprovalSetup,
          delivery,
          nativeRuntime,
          authorizeActorAction: vi.fn(),
        },
      }),
    ).toEqual({
      describeExecApprovalSetup,
      describePluginApprovalSetup,
      delivery,
      nativeRuntime,
      render: undefined,
      native: undefined,
    });
  });
});
