import { expectDefined } from "@openclaw/normalization-core/expect";
import { beforeEach, expect, it, vi } from "vitest";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { readSessionActorStorageResult } from "../config/sessions/session-actor-storage-result.js";
import type { SessionDeliveryState } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { prepareApprovalChannelCustody } from "./approval-channel-custody.js";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  config: { listAccountIds: vi.fn(), defaultAccountId: vi.fn() },
  hasApproverSettings: { value: true },
  supportsScopedPluginReviewers: { value: false },
}));

// mock-isolation: Custody tests supply account and approver fixtures without loading channel plugins.
vi.mock("../channels/plugins/index.js", () => ({
  getLoadedChannelPlugin: () => mocks,
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

// mock-isolation: Match synthetic owners without loading channel plugins; qa-channel covers that boundary.
vi.mock("../auto-reply/command-auth.js", () => ({
  isConfiguredCommandOwner: (cfg: OpenClawConfig, actor: { channel: string; senderId: string }) =>
    cfg.commands?.ownerAllowFrom?.includes(`${actor.channel}:${actor.senderId}`) === true,
}));

const reviewer = (accountId: string) => ({ channel: "telegram", accountId, senderId: "owner" });
const request = <T>(payload: T, id = "approval-1") => ({
  id,
  request: payload,
  createdAtMs: 1,
  expiresAtMs: 2,
});
const pluginRequest = (channel: string, accountId: string, pluginKey?: string) =>
  request(
    {
      title: "Review",
      description: "Allow access",
      turnSourceChannel: channel,
      turnSourceAccountId: accountId,
      ...(pluginKey ? { policySubject: { pluginKey } } : {}),
    },
    `plugin:${pluginKey ?? "calendar"}`,
  );
type CustodyParams = Parameters<typeof prepareApprovalChannelCustody>[0];
const prepare = (
  approvalKind: CustodyParams["approvalKind"],
  actor: CustodyParams["reviewer"],
  cfg: OpenClawConfig = {},
) => prepareApprovalChannelCustody({ cfg, approvalKind, reviewer: actor });

beforeEach(() => {
  mocks.authorize.mockReset().mockReturnValue({ authorized: true });
  mocks.config.listAccountIds.mockReset().mockReturnValue(["default", "ops"]);
  mocks.config.defaultAccountId.mockReset().mockReturnValue("default");
  mocks.hasApproverSettings.value = true;
  mocks.supportsScopedPluginReviewers.value = false;
});

it("selects source-bound, targeted, and uniquely authorized accounts", async () => {
  const check = async (
    expected: Record<string, boolean>,
    cfg: OpenClawConfig = {},
    source: { turnSourceChannel?: string; turnSourceAccountId?: string } = {},
    accounts = ["default", "ops"],
    eligible = accounts,
  ) => {
    mocks.config.listAccountIds.mockReturnValue(accounts);
    mocks.authorize.mockImplementation(({ accountId }: { accountId: string }) => ({
      authorized: eligible.includes(accountId),
    }));
    for (const [accountId, authorized] of Object.entries(expected)) {
      expect(
        await prepare("exec", reviewer(accountId), cfg)?.authorizes(
          request({ command: "printf approval", ...source }),
        ),
        accountId,
      ).toBe(authorized);
    }
  };
  const bound = { turnSourceChannel: "telegram", turnSourceAccountId: "ops" };
  await check({ ops: true, default: false }, {}, bound);
  const targets = [
    { channel: "telegram", to: "1" },
    { channel: "telegram", to: "2", accountId: "ops" },
  ];
  await check(
    { default: true, ops: true, other: false },
    { approvals: { exec: { enabled: true, mode: "targets", targets } } },
    {},
    ["default", "ops", "other"],
  );
  await check({ ops: true }, {}, {}, ["default", "ops"], ["ops"]);
  await check({ ops: false });
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
  const custody = prepare("exec", reviewer("ops"), { session: { store: location.path } });
  const pending = request({ command: "printf approval", sessionKey });
  try {
    const storage = expectDefined(actor.storage, "memory actor storage");
    const mutate = async (operation: Parameters<typeof storage.mutate>[0]) =>
      readSessionActorStorageResult(await storage.mutate(operation, authority));
    await mutate({
      type: "session.metadata.initialize",
      input: {
        scope: { agentId: "main", storePath: location.path, sessionKey, sessionId },
        entry: { sessionId, updatedAt: 1, incognito: true, delivery: delivery("ops") },
      },
    });
    expect(await custody?.authorizes(pending)).toBe(true);
    expect(custody?.isCurrent(pending)).toBe(true);

    await mutate({
      type: "session.entry.patch",
      input: { operation: { kind: "fields", patch: { delivery: delivery("default") } } },
    });
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
  const custody = prepare("plugin", reviewer("ops"));
  const pending = (pluginKey: string) => pluginRequest("telegram", "ops", pluginKey);

  expect(await custody?.authorizes(pending("calendar"))).toBe(true);
  expect(await custody?.authorizes(pending("other"))).toBe(false);
  expect(mocks.authorize).toHaveBeenCalledWith(
    expect.objectContaining({ request: pending("calendar") }),
  );
});

it("requires a channel capability to enforce configured plugin reviewers", async () => {
  const cfg: OpenClawConfig = {
    approvals: { plugin: { slack: { approvers: ["team:T11111111:user:U11111111"] } } },
  };
  const slackReviewer = { channel: "slack", accountId: "default", senderId: "U22222222" };
  const pending = pluginRequest("slack", "default");

  expect(prepare("plugin", slackReviewer, cfg)).toBeNull();
  expect(mocks.authorize).not.toHaveBeenCalled();

  mocks.supportsScopedPluginReviewers.value = true;
  expect(await prepare("plugin", slackReviewer, cfg)?.authorizes(pending)).toBe(true);
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
    const custody = prepare(approvalKind, { ...ircSender, senderId }, cfg);
    if (allowed) {
      expect(await custody?.authorizes(change)).toBe(true);
    } else {
      expect(custody).toBeNull();
    }
  }
});
