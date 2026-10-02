import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseTelegramTargetForTest } from "../../../test/helpers/infra/telegram-targets.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  createTargetsTestRegistry,
  forumMessagingForTest,
  telegramMessagingForTest,
} from "../../infra/outbound/targets.test-helpers.js";
import { buildChannelOutboundSessionRoute } from "../../plugin-sdk/core.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin } from "../../test-utils/channel-plugins.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";

const { extractDeliveryInfoMock, sessionEntries } = vi.hoisted(() => ({
  extractDeliveryInfoMock: vi.fn(),
  sessionEntries: new Map<string, SessionEntry>(),
}));

vi.mock("../../config/sessions/delivery-info.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/delivery-info.js")>()),
  extractDeliveryInfo: extractDeliveryInfoMock,
  extractDeliveryInfoBatch: (requests: Array<{ sessionKey?: string }>) =>
    requests.map(({ sessionKey }) =>
      sessionKey ? extractDeliveryInfoMock() : { deliveryContext: undefined, threadId: undefined },
    ),
}));

// mock-isolation: exercise delivery routing with controlled session entries, without worker I/O.
vi.mock("../../config/sessions/session-entry-read-runtime.js", () => ({
  readSessionEntriesFromStoreInWorker: async ({ sessionKeys }: { sessionKeys: string[] }) => ({
    entries: sessionKeys.flatMap((sessionKey) => {
      const entry = sessionEntries.get(sessionKey);
      return entry ? [{ sessionKey, entry }] : [];
    }),
  }),
}));

vi.mock("../../infra/outbound/channel-selection.runtime.js", () => ({
  resolveMessageChannelSelection: vi
    .fn()
    .mockResolvedValue({ channel: "alpha", configured: ["alpha"] }),
}));

// mock-isolation: Resolve delivery targets from scenario fixtures, not host channel state.
vi.mock("../../infra/outbound/targets.runtime.js", () => ({ resolveOutboundTarget: vi.fn() }));
const mockedModuleIds = [
  "../../config/sessions/delivery-info.js",
  "../../config/sessions/session-entry-read-runtime.js",
  "../../infra/outbound/channel-selection.runtime.js",
  "../../infra/outbound/targets.runtime.js",
];

import { resolveMessageChannelSelection } from "../../infra/outbound/channel-selection.runtime.js";
import { resolveOutboundTarget } from "../../infra/outbound/targets.runtime.js";
import { resolveDeliveryTarget } from "./delivery-target.js";

afterAll(() => {
  for (const id of mockedModuleIds) {
    vi.doUnmock(id);
  }
  vi.resetModules();
});

function createStubOutbound(label: string, checkAllowlist = false): ChannelOutboundAdapter {
  return {
    deliveryMode: "gateway",
    resolveTarget: ({ to, allowFrom }) => {
      const trimmed = typeof to === "string" ? to.trim() : "";
      if (!trimmed) {
        return { ok: false, error: new Error(`${label} requires target`) };
      }
      if (checkAllowlist && allowFrom && allowFrom.length > 0 && !allowFrom.includes(trimmed)) {
        return { ok: false, error: new Error(`${label} target blocked`) };
      }
      return { ok: true, to: trimmed };
    },
  };
}

const normalizeTelegramTargetForDeliveryTest = (raw: string): string | undefined => {
  const target = parseTelegramTargetForTest(raw);
  if (!target.chatId) {
    return undefined;
  }
  const normalizedTo = target.chatId.toLowerCase();
  return target.messageThreadId == null
    ? `telegram:${normalizedTo}`
    : `telegram:${normalizedTo}:topic:${target.messageThreadId}`;
};

const telegramMessaging = {
  ...telegramMessagingForTest,
  normalizeTarget: normalizeTelegramTargetForDeliveryTest,
};

function plugin(
  id: string,
  options: Partial<Parameters<typeof createOutboundTestPlugin>[0]> = {},
  overrides: Partial<ReturnType<typeof createOutboundTestPlugin>> = {},
) {
  const label = id.charAt(0).toUpperCase() + id.slice(1);
  return {
    ...createOutboundTestPlugin({ id, outbound: createStubOutbound(label), ...options }),
    ...overrides,
  };
}

beforeEach(() => {
  resetPluginRuntimeStateForTest();
  extractDeliveryInfoMock.mockReset();
  extractDeliveryInfoMock.mockReturnValue({ deliveryContext: undefined, threadId: undefined });
  vi.mocked(resolveOutboundTarget).mockReset();
  sessionEntries.clear();
  setPlugins(
    plugin("forum", { messaging: forumMessagingForTest }),
    plugin("telegram", { messaging: telegramMessaging }),
    {
      ...createOutboundTestPlugin({ id: "alpha", outbound: createStubOutbound("Alpha", true) }),
      config: {
        listAccountIds: () => [],
        resolveAccount: () => ({}),
        resolveAllowFrom: ({ cfg }: { cfg: OpenClawConfig }) =>
          (cfg.channels?.alpha as { allowFrom?: string[] } | undefined)?.allowFrom,
      },
    },
  );
});

afterEach(() => resetPluginRuntimeStateForTest());

function makeCfg(overrides?: Partial<OpenClawConfig>): OpenClawConfig {
  return { bindings: [], channels: {}, session: { store: "/tmp/test-store.json" }, ...overrides };
}

function setPlugins(...plugins: ReturnType<typeof createOutboundTestPlugin>[]) {
  setActivePluginRegistry(createTargetsTestRegistry(plugins));
}

function resolveTarget(
  target: Parameters<typeof resolveDeliveryTarget>[2],
  cfg = makeCfg(),
  options?: Parameters<typeof resolveDeliveryTarget>[3],
) {
  return resolveDeliveryTarget(cfg, AGENT_ID, target, options);
}

function expectTargetError(
  result: Awaited<ReturnType<typeof resolveDeliveryTarget>>,
  text: string,
) {
  expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining(text) } });
}

const AGENT_ID = "agent-b";
const DEFAULT_TARGET = { channel: "forum" as const, to: "room:default" };

function setSessionEntry(sessionKey: string, context: DeliveryContext) {
  sessionEntries.set(sessionKey, {
    sessionId: "session",
    updatedAt: 1000,
    delivery: normalizeSessionDeliveryState({ context }),
  });
}

function setLastSessionEntry(context: DeliveryContext) {
  setSessionEntry(`agent:${AGENT_ID}:main`, context);
}

describe("resolveDeliveryTarget", () => {
  it.each([
    [undefined, 0, true, 0, 2],
    ["room:default", undefined, true, undefined, 1],
    ["room:default", 0, false, undefined, 1],
    ["room:default", 0, true, 0, 3],
    ["room:other", 0, true, undefined, 2],
  ] as const)(
    "resolves historical routes only for explicit thread inheritance (%s, %s, %s)",
    async (to, threadId, inheritSessionThread, expectedThread, routeCalls) => {
      const resolveRoute = vi.fn(forumMessagingForTest.resolveOutboundSessionRoute!);
      setPlugins(
        plugin("forum", {
          messaging: { ...forumMessagingForTest, resolveOutboundSessionRoute: resolveRoute },
        }),
      );
      const sessionKey = `agent:${AGENT_ID}:source`;
      setSessionEntry(sessionKey, { channel: "forum", to: "room:default", threadId });
      const result = await resolveTarget({ channel: "forum", to, sessionKey }, makeCfg(), {
        dryRun: true,
        inheritSessionThread,
      });
      expect(result).toMatchObject({
        ok: true,
        to: to ?? "room:default",
        threadId: expectedThread,
        sessionRoute: { to: to ?? "room:default" },
      });
      expect(result.ok && result.sessionRoute?.threadId).toBe(expectedThread);
      expect(resolveRoute).toHaveBeenCalledTimes(routeCalls);
    },
  );

  it.each([
    // Regression #91613: the shared main bucket can belong to another conversation.
    ["shared recipient", undefined, "alpha", "wrong room"],
    ["missing target", undefined, "alpha", "requires target"],
    ["empty recipient", "telegram:", "telegram", "Target is required"],
    ["ambiguous channel", undefined, undefined, "Channel is required"],
  ] as const)("rejects %s", async (scenario, to, channel, message) => {
    if (scenario === "shared recipient") {
      setLastSessionEntry({ channel: "alpha", to: "room-allowed" });
    } else if (scenario === "ambiguous channel") {
      vi.mocked(resolveMessageChannelSelection).mockRejectedValueOnce(
        new Error("Channel is required when multiple channels are configured: alpha, forum"),
      );
    }
    const result = await resolveTarget({ channel: "last", to });
    expect(result).toMatchObject({ channel, to: undefined });
    expectTargetError(result, message);
  });

  it("applies allowFrom rerouting to dry-run delivery previews", async () => {
    setLastSessionEntry({ channel: "alpha", to: "room-denied" });

    const cfg = makeCfg({ channels: { alpha: { allowFrom: ["room-allowed"] } } });
    const result = await resolveTarget({ channel: "last" }, cfg, { dryRun: true });

    expect(result).toMatchObject({ ok: true, channel: "alpha", to: "room-allowed" });
  });

  it("falls back to the session for a whitespace-only account", async () => {
    setLastSessionEntry({
      channel: "forum",
      to: "room:other-conversation",
      accountId: "session-account",
    });

    const cfg = makeCfg({
      bindings: [{ agentId: AGENT_ID, match: { channel: "forum", accountId: "account-b" } }],
    });
    const result = await resolveTarget({ channel: "forum", to: "room:ops", accountId: "   " }, cfg);

    expect(result).toMatchObject({ ok: true, accountId: "session-account", to: "room:ops" });
  });

  it.each(["directory", "normalizer"])(
    "surfaces %s errors without resolving raw names",
    async (stage) => {
      const message =
        stage === "directory" ? "directory auth failed" : "target normalizer exploded";
      const fail = () => {
        throw new Error(message);
      };
      const fixture =
        stage === "directory"
          ? plugin(
              "alpha",
              { messaging: { targetPrefixes: ["alpha"] }, capabilities: { chatTypes: ["group"] } },
              { directory: { listGroups: async () => fail() } },
            )
          : plugin("alpha", { outbound: { deliveryMode: "gateway", resolveTarget: fail } });
      setPlugins(fixture);
      expectTargetError(
        await resolveTarget({
          channel: "alpha",
          to: stage === "directory" ? "ops" : "room:default",
        }),
        stage === "directory" ? message : `Invalid delivery target: ${message}`,
      );
    },
  );

  it("resolves cron reserved explicit targets through directory entries", async () => {
    setPlugins(
      plugin(
        "telegram",
        {
          capabilities: { chatTypes: ["group"] },
          messaging: {
            ...telegramMessaging,
            targetResolver: { reservedLiterals: ["current"], hint: "<chatId>" },
          },
        },
        {
          directory: {
            listGroups: async () => [{ kind: "group", id: "-1002458651455", name: "current" }],
          },
        },
      ),
    );

    const result = await resolveTarget({ channel: "telegram", to: "current" });

    expect(result).toMatchObject({ ok: true, to: "-1002458651455", threadId: undefined });
  });

  it("ignores stale previous-route parse failures for explicit cron targets", async () => {
    setLastSessionEntry({ channel: "alpha", to: "bad:stored:target", threadId: "old-thread" });
    setPlugins(
      plugin("alpha", {
        messaging: {
          targetPrefixes: ["alpha"],
          resolveOutboundSessionRoute: ({ cfg, agentId, accountId, target }) => {
            if (target === "bad:stored:target") {
              throw new Error("stale route parse failed");
            }
            const stripped = target.replace(/^alpha:/i, "");
            return buildChannelOutboundSessionRoute({
              cfg,
              agentId,
              channel: "alpha",
              accountId,
              peer: { kind: "group", id: stripped },
              chatType: "group",
              from: `alpha:group:${stripped}`,
              to: stripped,
            });
          },
        },
      }),
    );

    const result = await resolveTarget({ channel: "alpha", to: "alpha:room-a" });

    expect(result).toMatchObject({ ok: true, to: "room-a", threadId: undefined });
  });

  it("falls back to the runtime target resolver when the channel plugin is not already loaded", async () => {
    setPlugins(plugin("alpha"));
    vi.mocked(resolveOutboundTarget).mockResolvedValueOnce({ ok: true, to: "room:default" });

    expect(await resolveTarget(DEFAULT_TARGET)).toMatchObject({
      ok: true,
      channel: "forum",
      to: "room:default",
      mode: "explicit",
    });
  });

  it("returns an unresolved target when the shared prefix guard rejects the explicit target", async () => {
    const resolveOutbound = vi.fn(() => ({ ok: true as const, to: "telegram:1234567890" }));
    setPlugins(
      plugin("alpha", { outbound: { deliveryMode: "gateway", resolveTarget: resolveOutbound } }),
      plugin("telegram", { messaging: telegramMessagingForTest }),
    );

    const result = await resolveTarget({ channel: "alpha", to: "telegram:1234567890" });

    expectTargetError(result, "belongs to telegram, not alpha");
    expect(resolveOutbound).not.toHaveBeenCalled();
  });

  it.each([
    ["room:other", "thread-1", undefined],
    ["room:default", "thread-2", "thread-2"],
  ])(
    "carries the previous thread only for the same recipient (%s)",
    async (to, threadId, expected) => {
      setLastSessionEntry({ channel: "forum", to, threadId });
      expect((await resolveTarget(DEFAULT_TARGET)).threadId).toBe(expected);
    },
  );

  it("does not carry a Telegram topic threadId to a bare explicit group target", async () => {
    setLastSessionEntry({ channel: "telegram", to: "-100200300:topic:77", threadId: "77" });
    const result = await resolveTarget({ channel: "telegram", to: "-100200300" });
    expect(result).toMatchObject({ ok: true, to: "-100200300", threadId: undefined });
  });

  it("prefers stored deliveryContext lookup over exact session-store entries", async () => {
    extractDeliveryInfoMock.mockReturnValueOnce({
      deliveryContext: {
        channel: "alpha",
        to: "RoomMixedCase",
        accountId: "primary",
        threadId: "thread-old-stored",
      },
      threadId: "thread-stored",
    });
    setSessionEntry("agent:test:thread:42", {
      channel: "alpha",
      to: "room-lowercase",
      threadId: "thread-old",
    });

    const result = await resolveTarget({
      channel: "last",
      sessionKey: "agent:test:thread:42",
    });

    expect(result).toMatchObject({
      ok: true,
      channel: "alpha",
      to: "RoomMixedCase",
      accountId: "primary",
      threadId: "thread-stored",
    });
  });

  it("resolves plugin default targets through the modern target route", async () => {
    setPlugins(
      plugin(
        "telegram",
        { messaging: telegramMessaging },
        {
          config: {
            listAccountIds: () => [],
            resolveAccount: () => ({}),
            resolveDefaultTo: () => "-100200300:77",
          },
        },
      ),
    );

    const result = await resolveTarget({ channel: "telegram", to: undefined });

    expect(result).toMatchObject({ ok: true, to: "-100200300", threadId: 77 });
  });

  it("keeps explicit delivery threadId when stripping telegram :topic: targets", async () => {
    const result = await resolveTarget({
      channel: "telegram",
      to: "63448508:topic:1008013",
      threadId: "42",
    });

    expect(result).toMatchObject({ ok: true, to: "63448508", threadId: "42" });
  });
});
