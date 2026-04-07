import { beforeEach, describe, expect, it, vi } from "vitest";

const getChannelPluginMock = vi.hoisted(() => vi.fn());

vi.mock("../channels/plugins/index.js", async () => {
  const actual = await vi.importActual<typeof import("../channels/plugins/index.js")>(
    "../channels/plugins/index.js",
  );
  return {
    ...actual,
    getChannelPlugin: (...args: unknown[]) => getChannelPluginMock(...args),
  };
});

import { resolveApprovalCommandAuthorization } from "./channel-approval-auth.js";

describe("resolveApprovalCommandAuthorization", () => {
  beforeEach(() => {
    getChannelPluginMock.mockReset();
  });

  it("allows commands by default when the channel has no approval override", () => {
    expect(
      resolveApprovalCommandAuthorization({
        cfg: {} as never,
        channel: "slack",
        senderId: "U123",
        kind: "exec",
      }),
    ).toEqual({ authorized: true, explicit: false });
  });

  it("delegates to the channel approval override when present", () => {
    getChannelPluginMock.mockReturnValue({
      approvalCapability: {
        authorizeActorAction: ({
          approvalKind,
        }: {
          action: "approve";
          approvalKind: "exec" | "plugin";
        }) =>
          approvalKind === "plugin"
            ? { authorized: false, reason: "plugin denied" }
            : { authorized: true },
      },
    });

    expect(
      resolveApprovalCommandAuthorization({
        cfg: {} as never,
        channel: "discord",
        accountId: "work",
        senderId: "123",
        kind: "exec",
      }),
    ).toEqual({ authorized: true, explicit: true });

    expect(
      resolveApprovalCommandAuthorization({
        cfg: {} as never,
        channel: "discord",
        accountId: "work",
        senderId: "123",
        kind: "plugin",
      }),
    ).toEqual({ authorized: false, reason: "plugin denied", explicit: true });
  });

  it("uses approvalCapability as the canonical approval auth contract", () => {
    getChannelPluginMock.mockReturnValue({
      approvalCapability: {
        authorizeActorAction: () => ({ authorized: true }),
        getActionAvailabilityState: () => ({ kind: "enabled" }),
      },
    });

    expect(
      resolveApprovalCommandAuthorization({
        cfg: {} as never,
        channel: "matrix",
        senderId: "123",
        kind: "exec",
      }),
    ).toEqual({ authorized: true, explicit: true });
  });

  it("keeps disabled approval availability implicit even when same-chat auth returns allow", () => {
    getChannelPluginMock.mockReturnValue({
      approvalCapability: {
        authorizeActorAction: () => ({ authorized: true }),
        getActionAvailabilityState: () => ({ kind: "disabled" }),
      },
    });

    expect(
      resolveApprovalCommandAuthorization({
        cfg: {} as never,
        channel: "slack",
        accountId: "work",
        senderId: "U123",
        kind: "exec",
      }),
    ).toEqual({ authorized: true, explicit: false });
  });
});
