import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareApprovalChannelCustody } from "./approval-channel-custody.js";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  listAccountIds: vi.fn(),
  defaultAccountId: vi.fn(),
  hasApproverSettings: { value: true },
  supportsScopedPluginReviewers: { value: false },
}));

vi.mock("../channels/plugins/index.js", () => ({
  getLoadedChannelPlugin: () => ({
    config: {
      listAccountIds: mocks.listAccountIds,
      defaultAccountId: mocks.defaultAccountId,
    },
  }),
  resolveChannelApprovalCapability: () =>
    mocks.hasApproverSettings.value
      ? {
          authorizeActorAction: mocks.authorize,
          ...(mocks.supportsScopedPluginReviewers.value
            ? { supportsScopedPluginApprovalApprovers: true }
            : {}),
        }
      : undefined,
}));

// Owner matching needs loaded channel plugins; the qa-channel scenario covers it for real.
vi.mock("../auto-reply/command-auth.js", () => ({
  isConfiguredCommandOwner: (
    cfg: OpenClawConfig,
    requester: { channel: string; senderId: string },
  ) =>
    cfg.commands?.ownerAllowFrom?.includes(`${requester.channel}:${requester.senderId}`) === true,
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
    mocks.listAccountIds.mockReset().mockReturnValue(["default", "ops"]);
    mocks.defaultAccountId.mockReset().mockReturnValue("default");
    mocks.hasApproverSettings.value = true;
    mocks.supportsScopedPluginReviewers.value = false;
  });

  it("selects source-bound, targeted, and uniquely authorized accounts", () => {
    const cases: {
      cfg?: OpenClawConfig;
      source?: { turnSourceChannel: string; turnSourceAccountId: string };
      accounts?: string[];
      eligible?: string[];
      expected: Record<string, boolean>;
    }[] = [
      {
        source: { turnSourceChannel: "telegram", turnSourceAccountId: "ops" },
        expected: { ops: true, default: false },
      },
      {
        cfg: {
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
        },
        accounts: ["default", "ops", "other"],
        expected: { default: true, ops: true, other: false },
      },
      { eligible: ["ops"], expected: { ops: true } },
      { expected: { ops: false } },
    ];
    for (const {
      cfg = {},
      source,
      accounts = ["default", "ops"],
      eligible = accounts,
      expected,
    } of cases) {
      mocks.listAccountIds.mockReturnValue(accounts);
      mocks.authorize.mockImplementation(({ accountId }: { accountId: string }) => ({
        authorized: eligible.includes(accountId),
      }));
      for (const [accountId, authorized] of Object.entries(expected)) {
        expect(
          prepareApprovalChannelCustody({
            cfg,
            approvalKind: "exec",
            reviewer: reviewer(accountId),
          })?.authorizes(request({ command: "printf approval", ...source })),
          accountId,
        ).toBe(authorized);
      }
    }
  });

  it("checks plugin reviewer custody against the pending request", () => {
    mocks.authorize.mockImplementation(({ request: pending }) => ({
      authorized: pending?.request.policySubject?.pluginKey === "calendar",
    }));
    const custody = prepareApprovalChannelCustody({
      cfg: {},
      approvalKind: "plugin",
      reviewer: reviewer("ops"),
    });
    const pending = (pluginKey: string) => ({
      id: `plugin:${pluginKey}`,
      request: {
        title: "Plugin approval",
        description: "Allow access",
        policySubject: { pluginKey },
        turnSourceChannel: "telegram",
        turnSourceAccountId: "ops",
      },
      createdAtMs: 1,
      expiresAtMs: 2,
    });

    expect(custody?.authorizes(pending("calendar"))).toBe(true);
    expect(custody?.authorizes(pending("other"))).toBe(false);
    expect(mocks.authorize).toHaveBeenCalledWith(
      expect.objectContaining({ request: pending("calendar") }),
    );
  });

  it("requires a channel capability to enforce configured plugin reviewers", () => {
    const cfg = {
      approvals: { plugin: { slack: { approvers: ["team:T11111111:user:U11111111"] } } },
    } as OpenClawConfig;
    const slackReviewer = { channel: "slack", accountId: "default", senderId: "U22222222" };
    const pending = {
      id: "plugin:calendar",
      request: {
        title: "Review",
        description: "Allow access",
        turnSourceChannel: "slack",
        turnSourceAccountId: "default",
      },
      createdAtMs: 1,
      expiresAtMs: 2,
    };

    expect(
      prepareApprovalChannelCustody({ cfg, approvalKind: "plugin", reviewer: slackReviewer }),
    ).toBeNull();
    expect(mocks.authorize).not.toHaveBeenCalled();

    mocks.supportsScopedPluginReviewers.value = true;
    expect(
      prepareApprovalChannelCustody({
        cfg,
        approvalKind: "plugin",
        reviewer: slackReviewer,
      })?.authorizes(pending),
    ).toBe(true);
  });

  it("grants owner custody only for system changes on channels without approver settings", () => {
    const ircSender = { channel: "irc", accountId: "default", senderId: "alice" };
    const cfg: OpenClawConfig = { commands: { ownerAllowFrom: ["irc:alice"] } };
    const change = request({ command: "set config logging.level to info" });
    mocks.hasApproverSettings.value = false;
    for (const [approvalKind, senderId, allowed] of [
      ["system-agent", "alice", true],
      ["system-agent", "bob", false],
      ["exec", "alice", false],
      ["plugin", "alice", false],
    ] as const) {
      const custody = prepareApprovalChannelCustody({
        cfg,
        approvalKind,
        reviewer: { ...ircSender, senderId },
      });
      if (allowed) {
        expect(custody?.authorizes(change)).toBe(true);
      } else {
        expect(custody).toBeNull();
      }
    }
  });
});
