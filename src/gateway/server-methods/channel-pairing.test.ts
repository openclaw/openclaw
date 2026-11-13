import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, expect, it, vi } from "vitest";
import {
  expectRpcError as expectError,
  expectRpcResult as expectSuccess,
} from "./rpc-response.test-support.js";

const mocks = vi.hoisted(() => ({
  approve: vi.fn(),
  approveCode: vi.fn(),
  captureOwnerGuard: vi.fn(),
  bootstrapOwner: vi.fn(),
  dismiss: vi.fn(),
  hasOwners: vi.fn(),
  listPlugins: vi.fn(),
  listRequests: vi.fn(),
  notify: vi.fn(),
}));

// mock-isolation: Pairing tests supply their channel inventory without loading live plugins.
vi.mock("../../channels/plugins/index.js", () => ({ listChannelPlugins: mocks.listPlugins }));
// mock-isolation: Pairing notification is observed without contacting a live channel.
vi.mock("../../channels/plugins/pairing.js", () => ({ notifyPairingApproved: mocks.notify }));
vi.mock("../../commands/doctor-command-owner.js", () => ({
  hasConfiguredCommandOwners: mocks.hasOwners,
}));
vi.mock("../../pairing/command-owner.js", () => ({
  bootstrapCommandOwnerFromPairing: mocks.bootstrapOwner,
}));
vi.mock("../../pairing/pairing-store.js", () => ({
  approveChannelPairingCode: mocks.approveCode,
  approveChannelPairingRequest: mocks.approve,
  CHANNEL_PAIRING_PENDING_MAX: 3,
  CHANNEL_PAIRING_PENDING_TTL_MS: 3_600_000,
  dismissChannelPairingRequest: mocks.dismiss,
  listChannelPairingRequests: mocks.listRequests,
  resolveChannelPairingRequestId: vi.fn(() => "opaque-request-id"),
}));
vi.mock("./local-state-owner.js", () => ({
  captureLocalStateMutationGuard: mocks.captureOwnerGuard,
}));

import { channelPairingHandlers } from "./channel-pairing.js";

const pairingPlugin = {
  id: "whatsapp",
  meta: { label: "WhatsApp" },
  pairing: { idLabel: "Phone number" },
  outbound: { deliveryMode: "gateway", sendText: vi.fn() },
  config: {
    listAccountIds: () => ["personal", "public", "unconfigured"],
    resolveAccount: (_cfg: unknown, accountId: string) => ({
      configured: accountId !== "unconfigured",
      dmPolicy: accountId === "public" ? "open" : "pairing",
      name: accountId === "personal" ? "Personal" : accountId,
    }),
    isConfigured: (account: { configured: boolean }) => account.configured,
    describeAccount: (account: { name: string }) => ({
      accountId: account.name,
      name: account.name,
    }),
  },
  security: {
    resolveDmPolicy: ({ account }: { account: { dmPolicy: string } }) => ({
      policy: account.dmPolicy,
      allowFromPath: "channels.whatsapp.allowFrom",
      approveHint: "approve",
    }),
  },
};

const target = { channel: "whatsapp", accountId: "personal", requestId: "opaque-request-id" };
const listSelector = { channel: "whatsapp", format: "cli" };
const codeSelector = { channel: "whatsapp", code: "SECRET12" };
const senderId = "+15551234567";
const timestamp = "2026-07-20T10:00:00.000Z";
const publicAccount = {
  channel: "whatsapp",
  channelLabel: "WhatsApp",
  accountId: "personal",
  accountLabel: "Personal",
  notifySupported: true,
};
function pairingEntry(id = senderId, meta?: Record<string, string>) {
  return {
    id,
    code: "SECRET12",
    createdAt: timestamp,
    lastSeenAt: timestamp,
    ...(meta ? { meta } : {}),
  };
}
function approved(id = senderId, meta?: Record<string, string>) {
  return { id, entry: pairingEntry(id, meta) };
}
async function invoke(
  method: keyof typeof channelPairingHandlers,
  params: Record<string, unknown>,
  scopes: string[] = [],
) {
  const respond = vi.fn();
  const handler = expectDefined(channelPairingHandlers[method], `${method} test invariant`);
  await handler({
    params,
    respond,
    context: { getRuntimeConfig: () => ({}), logGateway: { warn: vi.fn() } },
    client: { connect: { scopes } },
  } as unknown as Parameters<typeof handler>[0]);
  return respond;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listPlugins.mockReturnValue([pairingPlugin]);
  mocks.hasOwners.mockReturnValue(false);
  mocks.listRequests.mockResolvedValue([]);
  mocks.bootstrapOwner.mockResolvedValue({ ownerEntry: "whatsapp:+1555", status: "configured" });
  mocks.captureOwnerGuard.mockReturnValue(() => {});
});

it.each([
  ["channels.pairing.list", listSelector],
  ["channels.pairing.approve", codeSelector],
  ["channels.pairing.list", { ...listSelector, accountId: " ", expectedOwnerId: "owner" }],
  ["channels.pairing.approve", { ...codeSelector, accountId: " ", expectedOwnerId: "owner" }],
  [
    "channels.pairing.approve",
    { ...codeSelector, requestId: "opaque", accountId: "personal", expectedOwnerId: "owner" },
  ],
] as const)("rejects an invalid CLI selector for %s", async (method, params) => {
  const respond = await invoke(method, params, ["operator.admin"]);
  expectError(respond, { code: "INVALID_REQUEST" });
  expect(mocks.listRequests).not.toHaveBeenCalled();
  expect(mocks.approveCode).not.toHaveBeenCalled();
  expect(mocks.approve).not.toHaveBeenCalled();
});

it.each([
  ["channels.pairing.list", { ...listSelector, expectedOwnerId: "owner" }],
  ["channels.pairing.approve", { ...codeSelector, expectedOwnerId: "owner" }],
] as const)("requires current admin owner authority for %s", async (method, params) => {
  const denied = await invoke(method, params, ["operator.pairing"]);
  expectError(denied, { code: "FORBIDDEN", details: { mutationAccepted: false } });
  expect(mocks.captureOwnerGuard).not.toHaveBeenCalled();

  mocks.captureOwnerGuard.mockImplementationOnce(() => {
    throw new Error("owner replaced");
  });
  const replaced = await invoke(method, params, ["operator.admin"]);
  expectError(replaced, { details: { mutationAccepted: false, reason: "STATE_OWNER_CHANGED" } });
  expect(mocks.listRequests).not.toHaveBeenCalled();
  expect(mocks.approveCode).not.toHaveBeenCalled();
});

it.each(["sync", "async"] as const)(
  "lists only pairing-policy accounts with %s hooks without exposing the human code",
  async (hooks) => {
    if (hooks === "async") {
      const refuseSync = () => {
        throw new Error("legacy operational hook used");
      };
      mocks.listPlugins.mockReturnValue([
        {
          ...pairingPlugin,
          config: {
            ...pairingPlugin.config,
            resolveAccount: refuseSync,
            resolveAccountAsync: async (cfg: unknown, accountId: string) =>
              pairingPlugin.config.resolveAccount(cfg, accountId),
            describeAccount: refuseSync,
            describeAccountAsync: async (account: { name: string }) =>
              pairingPlugin.config.describeAccount(account),
          },
          security: {
            resolveDmPolicy: refuseSync,
            resolveDmPolicyAsync: async (context: { account: { dmPolicy: string } }) =>
              pairingPlugin.security.resolveDmPolicy(context),
          },
        },
      ]);
    }
    mocks.listRequests.mockResolvedValue([
      {
        ...pairingEntry(`workspace:personal:user:${senderId}`, {
          accountId: "personal",
          name: "Alice",
          senderId,
        }),
        lastSeenAt: "2026-07-20T10:05:00.000Z",
      },
    ]);

    const respond = await invoke("channels.pairing.list", {});

    expect(mocks.listRequests.mock.calls).toEqual([["whatsapp", process.env, "personal"]]);
    expectSuccess(respond, {
      accounts: [publicAccount],
      requests: [
        {
          requestId: "opaque-request-id",
          ...publicAccount,
          senderId,
          senderLabel: "Phone number",
          metadata: { name: "Alice" },
          createdAt: timestamp,
          lastSeenAt: "2026-07-20T10:05:00.000Z",
          expiresAt: "2026-07-20T11:00:00.000Z",
        },
      ],
      commandOwnerConfigured: false,
      limits: { pendingPerAccount: 3, ttlMs: 3_600_000 },
    });
    expect(JSON.stringify(respond.mock.calls)).not.toContain("SECRET12");
  },
);

it.each(["notification", "command-owner"])(
  "keeps DM approval after %s failure",
  async (failure) => {
    const notify = failure === "notification";
    const id = notify ? `workspace:personal:user:${senderId}` : senderId;
    const meta = { accountId: "personal", senderId };
    mocks.approve.mockResolvedValue(approved(id, notify ? meta : undefined));
    (notify ? mocks.notify : mocks.bootstrapOwner).mockRejectedValue(
      new Error("optional step failed"),
    );
    const respond = await invoke("channels.pairing.approve", {
      ...target,
      ...(notify ? { notify: true } : {}),
      bootstrapCommandOwner: true,
    });
    expect(mocks.approve).toHaveBeenCalledWith({
      ...target,
      pairingAdapter: pairingPlugin.pairing,
    });
    expect(mocks.bootstrapOwner).toHaveBeenCalledWith({ channel: "whatsapp", id });
    if (notify) {
      expect(mocks.notify).toHaveBeenCalledWith({
        channelId: "whatsapp",
        accountId: "personal",
        id,
        cfg: expect.any(Object),
        pairingAdapter: pairingPlugin.pairing,
        meta,
        gatewayOwnedDelivery: true,
      });
    }
    expectSuccess(respond, {
      requestId: target.requestId,
      senderId,
      notification: notify ? "failed" : "not-requested",
      commandOwnerBootstrap: notify ? "configured" : "unavailable",
    });
  },
);

it("does not notify a sender when the pairing request no longer exists", async () => {
  mocks.approve.mockResolvedValue(null);
  const respond = await invoke("channels.pairing.approve", { ...target, notify: true });
  expectError(respond, { code: "INVALID_REQUEST" });
  expect(mocks.notify).not.toHaveBeenCalled();
});

it("dismisses a request without approving the sender", async () => {
  mocks.dismiss.mockResolvedValue(approved());

  const respond = await invoke("channels.pairing.dismiss", target);

  expect(mocks.dismiss).toHaveBeenCalledWith(target);
  expect(mocks.approve).not.toHaveBeenCalled();
  expectSuccess(respond, { requestId: "opaque-request-id", senderId });
});
