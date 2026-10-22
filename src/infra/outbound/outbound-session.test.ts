import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { mockFirstRecordArg } from "../../test-utils/mock-call-assertions.js";
import {
  bindOutboundSessionEntry,
  ensureOutboundSessionEntry,
  resolveOutboundSessionRoute,
} from "./outbound-session.js";
import { routeFixture, routePlugin } from "./outbound-session.test-helpers.js";

const mocks = vi.hoisted(() => ({
  loadSessionEntryReadOnly:
    vi.fn<(params: { sessionKey: string; storePath: string }) => SessionEntry | undefined>(),
  updateSessionLastRoute: vi.fn(async (_params: { sessionKey?: string; storePath?: string }) => ({
    sessionId: "session-1",
    updatedAt: 1,
  })),
  resolveStorePath: vi.fn(
    (_store: unknown, params?: { agentId?: string }) => `/stores/${params?.agentId ?? "main"}.json`,
  ),
}));
vi.mock("../../config/sessions/inbound.runtime.js", () => ({
  resolveSessionStorePathCore: mocks.resolveStorePath,
  updateSessionLastRoute: mocks.updateSessionLastRoute,
}));
// mock-isolation: Session rows are supplied without starting persistent storage.
vi.mock("../../config/sessions/session-entry-read-runtime.js", () => ({
  readSessionEntryReadOnlyInWorker: async (params: { sessionKey: string; storePath: string }) =>
    mocks.loadSessionEntryReadOnly(params),
}));

const perChannelPeerCfg: OpenClawConfig = { session: { dmScope: "per-channel-peer" } };
type ResolveParams = Parameters<typeof resolveOutboundSessionRoute>[0];
const resolveRoute = (params: Omit<ResolveParams, "cfg" | "agentId"> & Partial<ResolveParams>) =>
  resolveOutboundSessionRoute({ cfg: perChannelPeerCfg, agentId: "main", ...params });
const telegramRoutePlugin = routePlugin(
  "telegram",
  routeFixture({
    sessionKey: "agent:main:telegram:group:-1001234567890:topic:42",
    peer: { kind: "group", id: "-1001234567890:topic:42" },
    chatType: "group",
    from: "telegram:group:-1001234567890:topic:42",
    to: "telegram:-1001234567890:topic:42",
  }),
);

beforeEach(() => {
  mocks.loadSessionEntryReadOnly.mockReset();
  mocks.updateSessionLastRoute.mockClear();
  mocks.resolveStorePath.mockClear();
  const plugin = {
    ...createChannelTestPluginBase({ id: "fallbackchat" }),
    messaging: {
      inferTargetChatType: ({ to }: { to: string }) =>
        to.startsWith("spaces/") ? ("group" as const) : undefined,
    },
  };
  setActivePluginRegistry(createTestRegistry([{ pluginId: plugin.id, plugin, source: "test" }]));
});

describe("resolveOutboundSessionRoute", () => {
  it.each([
    ["guildchat", "user-42", "user", "Alice", "directory", "directory", undefined, "Alice"],
    [
      "telegram",
      "group:room-id",
      "group",
      "room-id",
      "directory",
      "directory",
      telegramRoutePlugin,
      undefined,
    ],
    [
      "imessage",
      "imessage:Alice",
      "user",
      "Alice",
      "normalized",
      "plugin",
      routePlugin("imessage", routeFixture()),
      "Alice",
    ],
  ] as const)(
    "resolves %s display names from %s",
    async (channel, target, kind, display, source, resolutionSource, plugin, expected) => {
      expect(
        (
          await resolveRoute({
            channel,
            target,
            plugin,
            resolvedTarget: { to: target, kind, display, source, resolutionSource },
          })
        )?.displayName,
      ).toBe(expected);
    },
  );

  it("delegates normalized targets and routing context without rewriting a plugin route", async () => {
    const route = routeFixture({ sessionKey: "agent:main:reef:direct:peer:thread:7", threadId: 7 });
    const resolver = vi.fn(() => route);
    const plugin = routePlugin("reef", resolver);
    const params = {
      cfg: perChannelPeerCfg,
      agentId: "main",
      channel: "reef",
      plugin,
      target: " user:peer ",
      accountId: "account",
      threadId: 7,
      replyToId: "reply",
      currentSessionKey: "current",
    };
    expect(await resolveOutboundSessionRoute(params)).toEqual(route);
    expect(resolver).toHaveBeenCalledWith({ ...params, target: "user:peer" });
  });

  it.each([
    ["group", "team-room", "main", "per-group", "main", "", "agent:main:main", true],
    [
      "direct",
      "alice",
      "main",
      "per-channel-peer",
      "main",
      ":thread:topic-1",
      "agent:main:main",
      true,
    ],
    [
      "direct",
      "alice",
      "other",
      "per-channel-peer",
      "per-channel-peer",
      "",
      "agent:main:bound-channel:direct:alice",
      false,
    ],
  ] as const)(
    "applies %s binding to %s (%s)",
    async (kind, id, bindingAgentId, globalScope, bindingScope, suffix, expectedBase, exact) => {
      const base = `agent:main:bound-channel:${kind}:${id}`;
      const scopeKey = kind === "direct" ? "dmScope" : "groupScope";
      const route = await resolveRoute({
        cfg: {
          session: { [scopeKey]: globalScope },
          bindings: [
            {
              agentId: bindingAgentId,
              match: { channel: "bound-channel", peer: { kind, id } },
              session: { [scopeKey]: bindingScope },
            },
          ],
        } as OpenClawConfig,
        channel: "bound-channel",
        target: id,
        plugin: routePlugin(
          "bound-channel",
          routeFixture({
            sessionKey: base + suffix,
            baseSessionKey: base,
            recipientSessionExact: true,
            peer: { kind, id },
            chatType: kind,
            from: `bound-channel:${id}`,
            to: id,
          }),
        ),
      });
      expect(route).toMatchObject({
        sessionKey: expectedBase + suffix,
        baseSessionKey: expectedBase,
        recipientSessionExact: exact,
      });
    },
  );

  it.each([
    [
      "fallbackchat",
      "spaces/AAA",
      undefined,
      "group",
      "spaces/aaa",
      "fallbackchat:group:spaces/AAA",
      "channel:spaces/AAA",
    ],
    ["fallbackchat", "user:U123", undefined, "direct", "u123", "fallbackchat:U123", "user:U123"],
    ["guildchat", "456", "channel", "channel", "456", "guildchat:channel:456", "channel:456"],
    [
      "openclaw-weixin",
      "wxid_abc123@im.wechat",
      "user",
      "direct",
      "wxid_abc123@im.wechat",
      "openclaw-weixin:wxid_abc123@im.wechat",
      "user:wxid_abc123@im.wechat",
    ],
  ] as const)(
    "falls back to %s routing for %s",
    async (channel, target, resolvedKind, kind, id, from, to) => {
      expect(
        await resolveRoute({
          channel,
          target,
          resolvedTarget: resolvedKind
            ? { to: target, kind: resolvedKind, source: "directory", resolutionSource: "directory" }
            : undefined,
        }),
      ).toMatchObject({
        sessionKey: `agent:main:${channel}:${kind}:${id}`,
        from,
        to,
        chatType: kind,
      });
    },
  );

  it("propagates plugin resolver errors", async () => {
    const error = new Error("Ambiguous recipient");
    await expect(
      resolveRoute({
        channel: "reef",
        target: "123",
        plugin: routePlugin("reef", () => {
          throw error;
        }),
      }),
    ).rejects.toBe(error);
  });
});

function readMetadata() {
  return mockFirstRecordArg(
    mocks.updateSessionLastRoute,
    "updateSessionLastRoute",
    "expected updateSessionLastRoute params to be an object",
  );
}

describe("ensureOutboundSessionEntry", () => {
  it("persists metadata in the owning session store for the route session key", async () => {
    await ensureOutboundSessionEntry({
      cfg: { session: { store: "/stores/{agentId}.json" } },
      channel: "workspace",
      route: routeFixture({
        sessionKey: "agent:main:workspace:channel:c1",
        baseSessionKey: "agent:work:workspace:channel:resolved",
        peer: { kind: "channel", id: "c1" },
        chatType: "channel",
        from: "workspace:channel:C1",
        to: "channel:C1",
      }),
    });
    expect(mocks.resolveStorePath).toHaveBeenCalledWith("/stores/{agentId}.json", {
      agentId: "main",
    });
    expect(mocks.updateSessionLastRoute).toHaveBeenCalledOnce();
    expect(readMetadata()).toMatchObject({
      storePath: "/stores/main.json",
      sessionKey: "agent:main:workspace:channel:c1",
      ctx: { NativeChannelId: "c1", OriginatingTo: "channel:C1" },
    });
  });

  it("does not persist an identifier-only target as a group title", async () => {
    const route = await resolveRoute({
      cfg: { session: { groupScope: "per-group" } } as OpenClawConfig,
      channel: "telegram",
      plugin: telegramRoutePlugin,
      target: "-1001234567890:topic:42",
      resolvedTarget: {
        to: "telegram:-1001234567890:topic:42",
        kind: "group",
        display: "telegram:-1001234567890:topic:42",
        source: "normalized",
        resolutionSource: "normalized",
      },
    });
    expect(route).toBeDefined();
    if (!route) {
      return;
    }
    expect(route.displayName).toBeUndefined();
    await ensureOutboundSessionEntry({ cfg: {}, channel: "telegram", route });
    expect((readMetadata().ctx as Record<string, unknown>).GroupSubject).toBeUndefined();
  });

  it.each(["operator", "required-parent"] as const)(
    "carries %s creation policy without requiring current role configuration",
    async (source) => {
      const actor = { type: "human" as const, source: "profile" as const, id: "outbound-creator" };
      const creation = { via: "operator" as const, actor, sandbox: "required" as const };
      mocks.loadSessionEntryReadOnly.mockImplementation((params) =>
        params.sessionKey === "agent:other:main" && params.storePath === "/stores/other.json"
          ? {
              sessionId: "source-session",
              updatedAt: 1,
              createdVia: "operator",
              createdActor: actor,
              ...(source === "required-parent" ? { sandbox: "required" as const } : {}),
            }
          : undefined,
      );
      await ensureOutboundSessionEntry({
        cfg: {},
        channel: "reef",
        route: routeFixture({
          sessionKey: "agent:main:reef:direct:first-contact",
          peer: { kind: "direct", id: "first-contact" },
          from: "reef:first-contact",
          to: "user:first-contact",
        }),
        ...(source === "operator" ? { creation } : { sourceSessionKey: "agent:other:main" }),
      });
      expect(readMetadata().ctx).toMatchObject({ SessionCreation: creation });
    },
  );

  it.each([
    ["best-effort send", ensureOutboundSessionEntry, false],
    ["required conversation binding", bindOutboundSessionEntry, true],
  ] as const)("handles persistence failures for %s", async (_name, persist, required) => {
    mocks.updateSessionLastRoute.mockRejectedValueOnce(new Error("storage unavailable"));
    const result = persist({ cfg: {}, channel: "reef", route: routeFixture() });
    if (required) {
      await expect(result).rejects.toThrow("storage unavailable");
    } else {
      await expect(result).resolves.toBeUndefined();
    }
  });
});
