import { expect, it, vi } from "vitest";
import type { SessionsResolveParams } from "../../packages/gateway-protocol/src/index.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  appendTranscriptMessage,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { startExactAuthorizationRequest } from "./server-methods.authorization.test-support.js";
import { sessionReadHandlers } from "./server-methods/sessions-read.js";
import type { RespondFn } from "./server-methods/types.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";

const authority = vi.hoisted(() => ({ member: true, prepare: vi.fn(), check: vi.fn() }));
vi.mock("../state/user-channel-identity-operations.js", () => ({
  prepareUserProfileRoleAuthority: async (profileId: string) => ({
    profileId,
    isCurrent: () => true,
  }),
}));
vi.mock("./session-channel-membership.js", () => ({
  prepareTelegramGroupMemberships: authority.prepare,
  prepareTelegramGroupMembership: authority.check,
}));

const key = "agent:main:telegram:group:-123456";
const group = { accountId: "default", groupId: "-123456" };
const entry = {
  sessionId: "channel-session",
  updatedAt: 1,
  createdVia: "channel" as const,
  createdActor: { type: "human" as const, source: "channel" as const, id: "777" },
  delivery: {
    kind: "external" as const,
    route: { channel: "telegram", accountId: "default", target: { to: "telegram:-123456" } },
    context: {},
    origin: { provider: "telegram", chatType: "group", nativeChannelId: "-123456" },
  },
};

async function fixture(
  options: { member?: boolean; private?: boolean; source?: boolean; allowed?: boolean },
  run: (args: {
    resolve: (params: SessionsResolveParams) => Promise<unknown[]>;
    profileId: string;
    get: (confirmed?: boolean) => Promise<unknown[]>;
    preview: (confirmed?: boolean) => Promise<unknown[]>;
    dispatchPreview: () => Promise<unknown[]>;
    revoke: () => void;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const client = roleClient("none", "channel-resolve-viewer");
    const controller = new AbortController();
    client.connectionSignal = controller.signal;
    const profileId = client.authenticatedUserProfile!.profileId;
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { main: {} } },
      ...rolePolicyConfig(),
      ...(options.source
        ? {
            session: {
              sharing: {
                accessPolicy: {
                  default: "creator" as const,
                  groups: [
                    {
                      agentId: "main",
                      channel: "telegram",
                      peerId: "-123456",
                      profileIds: options.allowed ? [profileId] : ["another-profile"],
                    },
                  ],
                },
              },
            },
          }
        : {}),
    };
    setRuntimeConfigSnapshot(cfg);
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: key },
      {
        ...entry,
        ...(options.private ? { access: { mode: "creator" as const } } : {}),
        ...(options.source ? { access: { mode: "source" as const } } : {}),
      },
    );
    await appendTranscriptMessage(
      { agentId: "main", sessionKey: key, sessionId: entry.sessionId },
      { message: { role: "user", content: "Synthetic participant message", timestamp: 1 } },
    );
    authority.member = options.member !== false;
    authority.check.mockReset();
    authority.check.mockImplementation(async () =>
      authority.member ? { isCurrent: () => true } : undefined,
    );
    authority.prepare.mockReset();
    authority.prepare.mockImplementation(
      async ({ groups }: { groups: (typeof group)[] }) =>
        new Map(
          groups.map((g) => [
            JSON.stringify([g.accountId, g.groupId]),
            authority.member ? { isCurrent: () => true } : undefined,
          ]),
        ),
    );
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    try {
      await projection.ensureMaterialized();
      const context = createDirectChatContext({
        getRuntimeConfig: () => cfg,
        ...bindSessionRowProjection({}, () => projection),
      });
      const resolve = async (params: SessionsResolveParams) => {
        const respond = vi.fn<RespondFn>();
        await sessionReadHandlers["sessions.resolve"]!({
          params,
          respond,
          client,
          context,
          req: { type: "req", id: "resolve", method: "sessions.resolve" },
          isWebchatConnect: () => false,
        });
        expect(respond).toHaveBeenCalledOnce();
        return respond.mock.calls[0]!;
      };
      const get = async (confirmed = true) => {
        const respond = vi.fn<RespondFn>();
        await sessionReadHandlers["sessions.get"]!({
          params: { key },
          respond,
          client: confirmed
            ? client
            : { ...client, authenticatedUserProfile: undefined, authenticatedUserId: undefined },
          context,
          req: { type: "req", id: "get", method: "sessions.get" },
          isWebchatConnect: () => false,
        });
        expect(respond).toHaveBeenCalledOnce();
        return respond.mock.calls[0]!;
      };
      const dispatchPreview = async () => {
        const { request, respond } = startExactAuthorizationRequest(
          "sessions.preview",
          { keys: [key] },
          {
            client,
            context,
            extraHandlers: { "sessions.preview": sessionReadHandlers["sessions.preview"]! },
          },
        );
        await request;
        expect(respond).toHaveBeenCalledOnce();
        return respond.mock.calls[0]!;
      };
      const preview = async (confirmed = true) => {
        const respond = vi.fn<RespondFn>();
        await sessionReadHandlers["sessions.preview"]!({
          params: { keys: [key] },
          respond,
          client: confirmed
            ? client
            : { ...client, authenticatedUserProfile: undefined, authenticatedUserId: undefined },
          context,
          req: { type: "req", id: "preview", method: "sessions.preview" },
          isWebchatConnect: () => false,
        });
        expect(respond).toHaveBeenCalledOnce();
        return respond.mock.calls[0]!;
      };
      await run({
        resolve,
        profileId,
        get,
        preview,
        dispatchPreview,
        revoke: () => {
          authority.member = false;
        },
      });
    } finally {
      controller.abort();
      projection.dispose();
    }
  });
}

it.each(["reference", "key"] as const)(
  "prepares Telegram authority on a fresh connection for %s",
  async (selector) => {
    await fixture({}, async ({ resolve }) => {
      const params = selector === "reference" ? { reference: { key } } : { key };
      const result = await resolve({ ...params, agentId: "main", allowMissing: true });
      expect(result[0]).toBe(true);
      expect(result[1]).toMatchObject({ ok: true, key, agentId: "main" });
      expect(authority.prepare).toHaveBeenCalledOnce();
      expect(authority.prepare.mock.calls[0]![0].groups).toEqual([group]);
    });
  },
);

it.each([
  ["nonmember", { member: false }],
  ["private ACL", { private: true }],
  ["revoked source ACL", { source: true, allowed: false }],
] as const)("does not grant a %s access", async (_label, options) => {
  await fixture(options, async ({ resolve }) => {
    const [, payload] = await resolve({ reference: { key }, agentId: "main", allowMissing: true });
    expect(payload).not.toMatchObject({ ok: true, key });
  });
});

it("honors an allowed source ACL without a broad role grant", async () => {
  await fixture({ source: true, allowed: true }, async ({ resolve }) => {
    const [, payload] = await resolve({ reference: { key }, agentId: "main", allowMissing: true });
    expect(payload).toMatchObject({ ok: true, key });
  });
});

it("uses the request-authorized Telegram membership owner for an ordinary participant preview", async () => {
  await fixture({}, async ({ dispatchPreview }) => {
    const [ok, result] = await dispatchPreview();
    expect(ok).toBe(true);
    expect(result).toMatchObject({
      previews: [
        {
          key,
          status: "ok",
          items: [{ role: "user", text: "Synthetic participant message" }],
        },
      ],
    });
    expect(authority.prepare).toHaveBeenCalledOnce();
    expect(authority.prepare.mock.calls[0]![0].groups).toEqual([group]);
  });
});

it.each([
  ["nonmember", { member: false }],
  ["private ACL", { private: true }],
  ["revoked source ACL", { source: true, allowed: false }],
] as const)("keeps preview fail-closed for %s", async (_label, options) => {
  await fixture(options, async ({ resolve, preview }) => {
    await resolve({ key, agentId: "main", allowMissing: true });
    const [ok, result] = await preview();
    expect(ok).toBe(true);
    expect(result).toEqual({
      ts: expect.any(Number),
      previews: [{ key, status: "missing", items: [] }],
    });
    expect(JSON.stringify(result)).not.toContain("Synthetic participant message");
  });
});

it("does not prepare or reveal a preview to an unconfirmed requester", async () => {
  await fixture({}, async ({ preview }) => {
    const [ok, result] = await preview(false);
    expect(ok).toBe(true);
    expect(result).toMatchObject({ previews: [{ key, status: "missing", items: [] }] });
    expect(authority.prepare).not.toHaveBeenCalled();
  });
});

it("checks fresh membership for each direct get on the same connection", async () => {
  await fixture({}, async ({ resolve, get, revoke }) => {
    const [, resolved] = await resolve({ key, agentId: "main", allowMissing: true });
    expect(resolved).toMatchObject({ ok: true, key });
    const [allowedOk, allowed] = await get();
    expect(allowedOk).toBe(true);
    expect(allowed).toMatchObject({
      messages: [
        expect.objectContaining({ role: "user", content: "Synthetic participant message" }),
      ],
    });
    expect(authority.check).toHaveBeenCalledTimes(1);
    revoke();
    const [deniedOk, denied] = await get();
    expect(deniedOk).toBe(true);
    expect(denied).toEqual({ messages: [] });
    expect(authority.check).toHaveBeenCalledTimes(2);
  });
});

it.each([
  ["nonmember", { member: false }],
  ["private ACL", { private: true }],
  ["revoked source ACL", { source: true, allowed: false }],
] as const)("does not grant direct get to %s", async (_label, options) => {
  await fixture(options, async ({ get }) => {
    const [deniedOk, denied] = await get();
    expect(deniedOk).toBe(true);
    expect(denied).toEqual({ messages: [] });
  });
});

it("does not grant a direct get to an unconfirmed requester", async () => {
  await fixture({}, async ({ resolve, get }) => {
    await resolve({ key, agentId: "main", allowMissing: true });
    const [ok, denied] = await get(false);
    expect(ok).toBe(true);
    expect(denied).toEqual({ messages: [] });
    expect(authority.check).not.toHaveBeenCalled();
  });
});
