import { expectDefined } from "@openclaw/normalization-core/expect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { readSessionActorStorageResult } from "../config/sessions/session-actor-storage-result.js";
import type { SessionDeliveryState } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { prepareApprovalChannelCustody } from "./approval-channel-custody.js";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  listAccountIds: vi.fn(),
  defaultAccountId: vi.fn(),
  hasApproverSettings: { value: true },
  supportsScopedPluginReviewers: { value: false },
}));

// mock-isolation: Custody tests supply account and approver fixtures without loading channel plugins.
vi.mock("../channels/plugins/index.js", () => ({
  getLoadedChannelPlugin: (() => {
    const plugin = {
      config: { listAccountIds: mocks.listAccountIds, defaultAccountId: mocks.defaultAccountId },
    };
    return () => plugin;
  })(),
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

  it("selects source-bound, targeted, and uniquely authorized accounts", async () => {
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
          await prepareApprovalChannelCustody({
            cfg,
            approvalKind: "exec",
            reviewer: reviewer(accountId),
          })?.authorizes(request({ command: "printf approval", ...source })),
          accountId,
        ).toBe(authorized);
      }
    }
  });

  it("invalidates unbound incognito custody after the memory delivery account changes", async () => {
    const sessionKey = "agent:main:dashboard:incognito-custody";
    const sessionId = "incognito-custody";
    const location = {
      agentId: "main",
      path: resolveIncognitoOpenClawAgentSqlitePath({
        agentId: "main",
        env: { OPENCLAW_STATE_DIR: "/synthetic/approval-channel-custody" },
      }),
    };
    const owner = memorySessionActorOwners.get(location);
    const actor = await owner.acquire(
      { database: owner.identity, sessionKey },
      { assertCurrent() {}, assertReadable() {} },
    );
    const authority = { assertCurrent() {}, authorize() {} };
    const delivery = (accountId: string): SessionDeliveryState => ({
      kind: "external",
      route: { channel: "telegram", accountId },
      context: { channel: "telegram", accountId },
      origin: { provider: "telegram", accountId },
    });
    const custody = prepareApprovalChannelCustody({
      cfg: { session: { store: location.path } },
      approvalKind: "exec",
      reviewer: reviewer("ops"),
    });
    const pending = {
      ...request({ command: "printf approval" }),
      request: { command: "printf approval", sessionKey },
    };
    try {
      const storage = expectDefined(actor.storage, "memory actor storage");
      readSessionActorStorageResult(
        await storage.mutate(
          {
            type: "session.metadata.initialize",
            input: {
              scope: { agentId: "main", storePath: location.path, sessionKey, sessionId },
              entry: { sessionId, updatedAt: 1, incognito: true, delivery: delivery("ops") },
            },
          },
          authority,
        ),
      );
      expect(await custody?.authorizes(pending)).toBe(true);
      expect(custody?.isCurrent(pending)).toBe(true);

      readSessionActorStorageResult(
        await storage.mutate(
          {
            type: "session.entry.patch",
            input: { operation: { kind: "fields", patch: { delivery: delivery("default") } } },
          },
          authority,
        ),
      );
      expect(custody?.isCurrent(pending)).toBe(false);
      expect(await custody?.authorizes(pending)).toBe(false);
    } finally {
      custody?.[Symbol.dispose]();
      await actor.release();
      memorySessionActorOwners.closeDatabase(location);
    }
  });

  it("checks plugin reviewer custody against the pending request", async () => {
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

    expect(await custody?.authorizes(pending("calendar"))).toBe(true);
    expect(await custody?.authorizes(pending("other"))).toBe(false);
    expect(mocks.authorize).toHaveBeenCalledWith(
      expect.objectContaining({ request: pending("calendar") }),
    );
  });

  it("requires a channel capability to enforce configured plugin reviewers", async () => {
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
      await prepareApprovalChannelCustody({
        cfg,
        approvalKind: "plugin",
        reviewer: slackReviewer,
      })?.authorizes(pending),
    ).toBe(true);
  });

  it("grants owner custody only for system changes on channels without approver settings", async () => {
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
        expect(await custody?.authorizes(change)).toBe(true);
      } else {
        expect(custody).toBeNull();
      }
    }
  });
});
