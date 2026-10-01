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

  it("authorizes only the account recorded by the request source", () => {
    const approval = request({
      command: "printf approval",
      turnSourceChannel: "telegram",
      turnSourceAccountId: "ops",
    });
    expect(
      prepareApprovalChannelCustody({
        cfg: {},
        approvalKind: "exec",
        reviewer: reviewer("ops"),
      })?.authorizes(approval),
    ).toBe(true);
    expect(
      prepareApprovalChannelCustody({
        cfg: {},
        approvalKind: "exec",
        reviewer: reviewer("default"),
      })?.authorizes(approval),
    ).toBe(false);
  });

  it("unions explicit scoped targets with the documented default account", () => {
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
        prepareApprovalChannelCustody({
          cfg,
          approvalKind: "exec",
          reviewer: reviewer(accountId),
        })?.authorizes(request({ command: "printf approval" })),
      ).toBe(true);
    }
    expect(
      prepareApprovalChannelCustody({
        cfg,
        approvalKind: "exec",
        reviewer: reviewer("other"),
      })?.authorizes(request({ command: "printf approval" })),
    ).toBe(false);
  });

  it("allows an unbound request only for one actor-authorized account", () => {
    mocks.authorize.mockImplementation(({ accountId }) => ({ authorized: accountId === "ops" }));
    expect(
      prepareApprovalChannelCustody({
        cfg: {},
        approvalKind: "exec",
        reviewer: reviewer("ops"),
      })?.authorizes(request({ command: "printf approval" })),
    ).toBe(true);

    mocks.authorize.mockReturnValue({ authorized: true });
    expect(
      prepareApprovalChannelCustody({
        cfg: {},
        approvalKind: "exec",
        reviewer: reviewer("ops"),
      })?.authorizes(request({ command: "printf approval" })),
    ).toBe(false);
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

  describe("channels without approver settings", () => {
    const ircSender = { channel: "irc", accountId: "default", senderId: "alice" };
    const ownerCfg = { commands: { ownerAllowFrom: ["irc:alice"] } } as OpenClawConfig;
    const change = request({ command: "set config logging.level to info" });

    beforeEach(() => {
      mocks.hasApproverSettings.value = false;
    });

    it("lets only a configured owner decide an OpenClaw change", () => {
      expect(
        prepareApprovalChannelCustody({
          cfg: ownerCfg,
          approvalKind: "system-agent",
          reviewer: ircSender,
        })?.authorizes(change),
      ).toBe(true);
      expect(
        prepareApprovalChannelCustody({
          cfg: ownerCfg,
          approvalKind: "system-agent",
          reviewer: { ...ircSender, senderId: "bob" },
        }),
      ).toBeNull();
    });

    it("grants no owner custody for exec or plugin approvals", () => {
      for (const approvalKind of ["exec", "plugin"] as const) {
        expect(
          prepareApprovalChannelCustody({ cfg: ownerCfg, approvalKind, reviewer: ircSender }),
        ).toBeNull();
      }
    });
  });
});
