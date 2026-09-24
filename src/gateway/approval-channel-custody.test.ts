import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareApprovalChannelCustody } from "./approval-channel-custody.js";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  prepare: vi.fn(),
  usePrepared: false,
  listAccountIds: vi.fn(),
  defaultAccountId: vi.fn(),
}));

vi.mock("../channels/plugins/index.js", () => ({
  getLoadedChannelPlugin: () => ({
    config: {
      listAccountIds: mocks.listAccountIds,
      defaultAccountId: mocks.defaultAccountId,
    },
  }),
  resolveChannelApprovalCapability: () => ({
    authorizeActorAction: mocks.authorize,
    ...(mocks.usePrepared ? { prepareActorAction: mocks.prepare } : {}),
  }),
}));

const reviewer = (accountId: string) => ({
  channel: "telegram",
  accountId,
  senderId: "owner",
});

const request = (payload: {
  command: string;
  turnSourceChannel?: string;
  turnSourceAccountId?: string;
}) => ({ id: "approval-1", request: payload, createdAtMs: 1, expiresAtMs: 2 });

describe("prepareApprovalChannelCustody", () => {
  beforeEach(() => {
    mocks.authorize.mockReset().mockReturnValue({ authorized: true });
    mocks.prepare.mockReset();
    mocks.usePrepared = false;
    mocks.listAccountIds.mockReset().mockReturnValue(["default", "ops"]);
    mocks.defaultAccountId.mockReset().mockReturnValue("default");
  });

  it("authorizes only the account recorded by the request source", async () => {
    const approval = request({
      command: "printf approval",
      turnSourceChannel: "telegram",
      turnSourceAccountId: "ops",
    });
    expect(
      (
        await prepareApprovalChannelCustody({
          getConfig: () => ({}),
          approvalKind: "exec",
          reviewer: reviewer("ops"),
        })
      )?.authorizes(approval),
    ).toBe(true);
    expect(
      (
        await prepareApprovalChannelCustody({
          getConfig: () => ({}),
          approvalKind: "exec",
          reviewer: reviewer("default"),
        })
      )?.authorizes(approval),
    ).toBe(false);
  });

  it("unions explicit scoped targets with the documented default account", async () => {
    const cfg: OpenClawConfig = {
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [
            { channel: "telegram", to: "1" },
            { channel: "telegram", to: "2", accountId: "ops" },
          ],
        },
      },
    };
    mocks.listAccountIds.mockReturnValue(["default", "ops", "other"]);
    for (const accountId of ["default", "ops"]) {
      expect(
        (
          await prepareApprovalChannelCustody({
            getConfig: () => cfg,
            approvalKind: "exec",
            reviewer: reviewer(accountId),
          })
        )?.authorizes(request({ command: "printf approval" })),
      ).toBe(true);
    }
    expect(
      (
        await prepareApprovalChannelCustody({
          getConfig: () => cfg,
          approvalKind: "exec",
          reviewer: reviewer("other"),
        })
      )?.authorizes(request({ command: "printf approval" })),
    ).toBe(false);
  });

  it("allows an unbound request only for one actor-authorized account", async () => {
    mocks.authorize.mockImplementation(({ accountId }) => ({ authorized: accountId === "ops" }));
    expect(
      (
        await prepareApprovalChannelCustody({
          getConfig: () => ({}),
          approvalKind: "exec",
          reviewer: reviewer("ops"),
        })
      )?.authorizes(request({ command: "printf approval" })),
    ).toBe(true);

    mocks.authorize.mockReturnValue({ authorized: true });
    expect(
      (
        await prepareApprovalChannelCustody({
          getConfig: () => ({}),
          approvalKind: "exec",
          reviewer: reviewer("ops"),
        })
      )?.authorizes(request({ command: "printf approval" })),
    ).toBe(false);
  });

  it("rechecks prepared channel identity before a pending decision commits", async () => {
    let linked = true;
    mocks.usePrepared = true;
    mocks.prepare.mockResolvedValue({ authorized: false });
    const params = {
      getConfig: () => ({}),
      approvalKind: "exec" as const,
      reviewer: reviewer("ops"),
    };
    expect(await prepareApprovalChannelCustody(params)).toBeNull();
    mocks.prepare.mockImplementation(async () => ({
      authorized: true,
      assertCurrent: () => {
        if (!linked) {
          throw new Error("identity unlinked");
        }
      },
    }));
    const custody = await prepareApprovalChannelCustody(params);
    const approval = request({
      command: "printf approval",
      turnSourceChannel: "telegram",
      turnSourceAccountId: "ops",
    });
    expect(custody?.authorizes(approval)).toBe(true);
    linked = false;
    expect(custody?.authorizes(approval)).toBe(false);
  });
});
