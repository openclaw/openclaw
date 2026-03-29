import { beforeEach, describe, expect, it, vi } from "vitest";

const getChannelPluginMock = vi.hoisted(() => vi.fn());

vi.mock("../channels/plugins/index.js", () => ({
  getChannelPlugin: (...args: unknown[]) => getChannelPluginMock(...args),
}));

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
    ).toEqual({ authorized: true });
  });

  it("delegates to the channel approval override when present", () => {
    getChannelPluginMock.mockReturnValue({
      auth: {
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
    ).toEqual({ authorized: true });

    expect(
      resolveApprovalCommandAuthorization({
        cfg: {} as never,
        channel: "discord",
        accountId: "work",
        senderId: "123",
        kind: "plugin",
      }),
    ).toEqual({ authorized: false, reason: "plugin denied" });
  });
});
