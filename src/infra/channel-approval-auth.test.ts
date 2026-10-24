import { beforeEach, expect, it, vi } from "vitest";
import type { ChannelApprovalCapability } from "../channels/plugins/types.adapters.js";
import { createResolvedApproverActionAuthAdapter } from "../plugin-sdk/approval-auth-helpers.js";

const getChannelPluginMock = vi.hoisted(() => vi.fn());
vi.mock("../channels/plugins/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../channels/plugins/index.js")>()),
  getChannelPlugin: (...args: unknown[]) => getChannelPluginMock(...args),
}));
import { resolveApprovalCommandAuthorization } from "./channel-approval-auth.js";

type AuthParams = Parameters<typeof resolveApprovalCommandAuthorization>[0];
function authorize(overrides: Partial<AuthParams> = {}) {
  return resolveApprovalCommandAuthorization({
    cfg: {},
    channel: "workspace",
    accountId: "work",
    senderId: "U123",
    kind: "exec",
    ...overrides,
  });
}
const availability = vi.fn(() => ({ kind: "disabled" as const }));
const mockCapability = (approvalCapability: ChannelApprovalCapability) =>
  getChannelPluginMock.mockReturnValue({ approvalCapability });

beforeEach(() => {
  getChannelPluginMock.mockReset();
  availability.mockClear();
});

it.each([
  ["no override", undefined, { accountId: undefined }],
  [
    "disabled",
    {
      authorizeActorAction: () => ({ authorized: true }),
      getActionAvailabilityState: availability,
    },
    {},
  ],
  [
    "empty approvers",
    createResolvedApproverActionAuthAdapter({
      channelLabel: "QuietChat",
      resolveApprovers: () => [],
    }),
    { channel: "quietchat", senderId: "uuid:attacker" },
  ],
] satisfies [string, ChannelApprovalCapability | undefined, Partial<AuthParams>][])(
  "keeps %s authorization implicit",
  async (name, capability, overrides) => {
    if (capability) {
      mockCapability(capability);
    }
    expect(await authorize(overrides)).toEqual({ authorized: true, explicit: false });
    if (name === "disabled") {
      expect(availability).toHaveBeenCalledWith({
        cfg: {},
        accountId: "work",
        action: "approve",
        approvalKind: "exec",
      });
    }
  },
);

it("delegates exec/plugin authorization to the channel", async () => {
  mockCapability({
    authorizeActorAction: ({ approvalKind }) =>
      approvalKind === "plugin"
        ? { authorized: false, reason: "plugin denied" }
        : { authorized: true },
  });
  const actor = { channel: "guildchat", senderId: "123" };
  expect(await authorize(actor)).toEqual({ authorized: true, explicit: true });
  expect(await authorize({ ...actor, kind: "plugin" })).toEqual({
    authorized: false,
    reason: "plugin denied",
    explicit: true,
  });
});

it("rejects legacy capabilities that cannot enforce scoped reviewers", async () => {
  const authorizeActorAction = vi.fn(() => ({ authorized: true }));
  mockCapability({ authorizeActorAction });
  const cfg = {
    approvals: { plugin: { slack: { approvers: ["team:T11111111:user:U11111111"] } } },
  };
  expect(
    await authorize({
      cfg,
      channel: "slack",
      accountId: "default",
      senderId: "U22222222",
      kind: "plugin",
    }),
  ).toMatchObject({ authorized: false, explicit: true });
  expect(authorizeActorAction).not.toHaveBeenCalled();
});
