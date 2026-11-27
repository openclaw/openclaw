import { expect, it, vi } from "vitest";
import type { SessionsResolveParams } from "../../packages/gateway-protocol/src/index.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  appendTranscriptMessage,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import * as historyWorker from "../config/sessions/session-history-worker-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { startExactAuthorizationRequest } from "./server-methods.authorization.test-support.js";
import { sessionReadHandlers } from "./server-methods/sessions-read.js";
import type { RespondFn } from "./server-methods/types.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";

const authority = vi.hoisted(() => ({
  member: true,
  prepare: vi.fn(),
  check: vi.fn(),
  list: vi.fn(),
  linked: vi.fn(),
}));
vi.mock("../state/user-channel-identity-operations.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../state/user-channel-identity-operations.js")>();
  return {
    ...actual,
    prepareUserProfileRoleAuthority: async (profileId: string) => ({
      profileId,
      isCurrent: () => true,
    }),
    listCanonicalUserChannelIdentities: authority.list,
    prepareUserChannelIdentityAuthority: authority.linked,
  };
});
vi.mock("./session-channel-membership.js", () => ({
  prepareTelegramGroupMemberships: authority.prepare,
  prepareTelegramGroupMembership: authority.check,
}));

const key = "agent:main:telegram:group:-123456";
const group = { accountId: "default", groupId: "-123456" };
const dmPeer = "54321";
const dmThread = "42";
const dmKey = `agent:main:telegram:direct:${dmPeer}:thread:${dmPeer}:${dmThread}`;
const dmEntry = {
  sessionId: "legacy-direct-session",
  updatedAt: 1,
  createdVia: "channel" as const,
  createdActor: { type: "human" as const, source: "channel" as const, id: dmPeer },
  delivery: {
    kind: "external" as const,
    route: {
      channel: "telegram",
      accountId: "default",
      target: { to: `telegram:${dmPeer}:topic:${dmThread}` },
      thread: { id: Number(dmThread) },
    },
    context: {},
    origin: {
      provider: "telegram",
      chatType: "direct" as const,
      accountId: "default",
      nativeDirectUserId: dmPeer,
      nativeChannelId: `${dmPeer}:topic:${dmThread}`,
      threadId: Number(dmThread),
    },
  },
};
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
  options: {
    member?: boolean;
    private?: boolean;
    source?: boolean;
    allowed?: boolean;
    direct?: boolean;
    legacyGrant?: boolean;
  },
  run: (args: {
    resolve: (params: SessionsResolveParams) => Promise<unknown[]>;
    profileId: string;
    sessionKey: string;
    content: string;
    get: (confirmed?: boolean) => Promise<unknown[]>;
    dispatchRead: (method: "sessions.get" | "sessions.preview") => Promise<unknown[]>;
    preview: (confirmed?: boolean) => Promise<unknown[]>;
    revoke: () => void;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const client = roleClient("none", "channel-resolve-viewer");
    const controller = new AbortController();
    client.connectionSignal = controller.signal;
    const profileId = client.authenticatedUserProfile!.profileId;
    let linkedCurrent = true;
    const sessionKey = options.direct ? dmKey : key;
    const sessionEntry = options.direct ? dmEntry : entry;
    const content = options.direct
      ? "Synthetic linked Telegram DM message"
      : "Synthetic participant message";
    authority.list.mockReset();
    authority.linked.mockReset();
    authority.list.mockImplementation(async (requestedProfileId: string) =>
      requestedProfileId === profileId
        ? [
            {
              profileId,
              identity: { channelId: "telegram", accountId: "default", senderId: dmPeer },
            },
          ]
        : [],
    );
    authority.linked.mockResolvedValue({
      linked: { profileId },
      isCurrent: () => linkedCurrent,
    });
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { main: {} } },
      ...rolePolicyConfig(),
      ...(options.direct
        ? {
            session: {
              sharing: {
                legacyDirectAccess: options.legacyGrant
                  ? [
                      {
                        channel: "telegram",
                        accountId: "default",
                        agentId: "main",
                        peerId: dmPeer,
                        profileIds: [profileId],
                      },
                    ]
                  : [],
              },
            },
          }
        : {}),
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
      { agentId: "main", sessionKey },
      {
        ...sessionEntry,
        ...(options.private ? { access: { mode: "creator" as const } } : {}),
        ...(options.source ? { access: { mode: "source" as const } } : {}),
      },
    );
    await appendTranscriptMessage(
      { agentId: "main", sessionKey, sessionId: sessionEntry.sessionId },
      { message: { role: "user", content, timestamp: 1 } },
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
          params: { key: sessionKey },
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
      const dispatchRead = async (method: "sessions.get" | "sessions.preview") => {
        const isGet = method === "sessions.get";
        const { request, respond } = startExactAuthorizationRequest(
          method,
          isGet ? { key: sessionKey } : { keys: [sessionKey] },
          {
            client,
            context,
            extraHandlers: isGet
              ? { "sessions.get": sessionReadHandlers["sessions.get"]! }
              : { "sessions.preview": sessionReadHandlers["sessions.preview"]! },
          },
        );
        await request;
        expect(respond).toHaveBeenCalledOnce();
        return respond.mock.calls[0]!;
      };
      const preview = async (confirmed = true) => {
        const respond = vi.fn<RespondFn>();
        await sessionReadHandlers["sessions.preview"]!({
          params: { keys: [sessionKey] },
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
        sessionKey,
        content,
        get,
        dispatchRead,
        preview,
        revoke: () => {
          authority.member = false;
          linkedCurrent = false;
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

it("preserves authorized Telegram group admission for sessions.get", async () => {
  await fixture({}, async ({ content, dispatchRead }) => {
    const [ok, payload] = await dispatchRead("sessions.get");
    expect(ok).toBe(true);
    expect(payload).toMatchObject({
      messages: [expect.objectContaining({ role: "user", content })],
    });
  });
});

it.each(["sessions.get", "sessions.preview"] as const)(
  "returns a linked ordinary participant's exact authorized legacy Telegram DM through %s",
  async (method) => {
    await fixture({ direct: true, legacyGrant: true }, async ({ content, dispatchRead }) => {
      const [ok, payload] = await dispatchRead(method);
      expect(ok).toBe(true);
      if (method === "sessions.get") {
        expect(payload).toMatchObject({
          messages: [expect.objectContaining({ role: "user", content })],
        });
      } else {
        expect(payload).toMatchObject({
          previews: [{ key: dmKey, status: "ok", items: [{ role: "user", text: content }] }],
        });
      }
      expect(authority.list).toHaveBeenCalled();
      expect(authority.linked).toHaveBeenCalled();
    });
  },
);

it("keeps a completed legacy DM read valid after the identity lookup deadline", async () => {
  await fixture({ direct: true, legacyGrant: true }, async ({ content, dispatchRead }) => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      expect(milliseconds).toBe(5_000);
      return deadline.signal;
    });
    const read = historyWorker.readSessionHistoryPageInWorker;
    vi.spyOn(historyWorker, "readSessionHistoryPageInWorker").mockImplementationOnce(((
      ...args: Parameters<typeof read>
    ) =>
      read(...args).then((result) => {
        deadline.abort();
        return result;
      })) as typeof read);
    try {
      const [ok, payload] = await dispatchRead("sessions.get");
      expect(ok).toBe(true);
      expect(payload).toMatchObject({
        messages: [expect.objectContaining({ role: "user", content })],
      });
      expect(deadline.signal.aborted).toBe(true);
    } finally {
      timeout.mockRestore();
    }
  });
});

it("keeps a legacy DM read closed when its linked identity is revoked during transcript I/O", async () => {
  await fixture({ direct: true, legacyGrant: true }, async ({ content, dispatchRead, revoke }) => {
    const read = historyWorker.readSessionHistoryPageInWorker;
    vi.spyOn(historyWorker, "readSessionHistoryPageInWorker").mockImplementationOnce(((
      ...args: Parameters<typeof read>
    ) =>
      read(...args).then((result) => {
        revoke();
        return result;
      })) as typeof read);
    const [ok, payload] = await dispatchRead("sessions.get");
    expect(ok).toBe(true);
    expect(payload).toEqual({ messages: [] });
    expect(JSON.stringify(payload)).not.toContain(content);
  });
});

it.each(["sessions.get", "sessions.preview"] as const)(
  "keeps a legacy Telegram DM denied without its exact legacyDirectAccess grant through %s",
  async (method) => {
    await fixture({ direct: true, legacyGrant: false }, async ({ content, dispatchRead }) => {
      const response = await dispatchRead(method);
      expect(response).toEqual([
        false,
        undefined,
        expect.objectContaining({
          code: "INVALID_REQUEST",
          message: `Session "${dmKey}" was not found.`,
        }),
      ]);
      expect(JSON.stringify(response)).not.toContain(content);
    });
  },
);

it("uses the request-authorized Telegram membership owner for an ordinary participant preview", async () => {
  await fixture({}, async ({ dispatchRead }) => {
    const [ok, result] = await dispatchRead("sessions.preview");
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
