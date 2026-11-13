import { expect, it, vi } from "vitest";
import type { SessionsResolveParams } from "../../packages/gateway-protocol/src/index.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { sessionReadHandlers } from "./server-methods/sessions-read.js";
import type { RespondFn } from "./server-methods/types.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";

const authority = vi.hoisted(() => ({ member: true, prepare: vi.fn() }));
vi.mock("../state/user-channel-identity-operations.js", () => ({
  prepareUserProfileRoleAuthority: async (profileId: string) => ({
    profileId,
    isCurrent: () => true,
  }),
}));
vi.mock("./session-channel-membership.js", () => ({
  prepareTelegramGroupMemberships: authority.prepare,
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
    authority.member = options.member !== false;
    authority.prepare.mockReset();
    authority.prepare.mockImplementation(
      async ({ groups }: { groups: (typeof group)[] }) =>
        new Map(
          groups.map((g) => [
            JSON.stringify([g.accountId, g.groupId]),
            authority.member ? { isCurrent: () => authority.member } : undefined,
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
      await run({ resolve, profileId });
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
