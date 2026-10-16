import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseTelegramTargetForTest } from "../../../test/helpers/infra/telegram-targets.js";
import type {
  ChannelDirectoryEntry,
  ChannelOutboundAdapter,
} from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  forumMessagingForTest,
  telegramMessagingForTest,
} from "../../infra/outbound/targets.test-helpers.js";
import { buildChannelOutboundSessionRoute } from "../../plugin-sdk/core.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";

const { extractDeliveryInfoMock, loadSessionEntry } = vi.hoisted(() => ({
  extractDeliveryInfoMock: vi.fn(),
  loadSessionEntry: vi.fn(),
}));

vi.mock("../../config/sessions/main-session.js", () => ({
  canonicalizeMainSessionAlias: vi.fn(({ sessionKey }) => sessionKey),
  resolveAgentMainSessionKey: vi.fn().mockReturnValue("agent:test:main"),
}));

vi.mock("../../config/sessions/delivery-info.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/delivery-info.js")>()),
  extractDeliveryInfo: extractDeliveryInfoMock,
  extractDeliveryInfoBatch: (
    requests: Array<{ sessionKey?: string; agentId?: string }>,
    options: { cfg?: OpenClawConfig },
  ) =>
    requests.map(({ sessionKey, agentId }) =>
      sessionKey
        ? extractDeliveryInfoMock(sessionKey, { ...options, agentId })
        : { deliveryContext: undefined, threadId: undefined },
    ),
}));

vi.mock("../../config/sessions/paths.js", () => ({
  resolveSessionStorePathCore: vi.fn().mockReturnValue("/tmp/test-store.json"),
}));

// mock-isolation: exercise delivery routing with controlled session entries, without worker I/O.
vi.mock("../../config/sessions/session-entry-read-runtime.js", () => ({
  readSessionEntriesFromStoreInWorker: async ({
    agentId,
    storePath,
    sessionKeys,
  }: {
    agentId: string;
    storePath: string;
    sessionKeys: string[];
  }) => ({
    entries: sessionKeys.flatMap((sessionKey) => {
      const entry = loadSessionEntry({ agentId, storePath, sessionKey });
      return entry ? [{ sessionKey, entry }] : [];
    }),
  }),
}));

vi.mock("../../infra/outbound/channel-selection.runtime.js", () => ({
  resolveMessageChannelSelection: vi
    .fn()
    .mockResolvedValue({ channel: "alpha", configured: ["alpha"] }),
}));

vi.mock("../../infra/outbound/targets.runtime.js", () => ({
  resolveOutboundTarget: vi.fn(),
}));
const mockedModuleIds = [
  "../../config/sessions/main-session.js",
  "../../config/sessions/delivery-info.js",
  "../../config/sessions/paths.js",
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

function createStubOutbound(label: string): ChannelOutboundAdapter {
  return {
    deliveryMode: "gateway",
    resolveTarget: ({ to }) => {
      const trimmed = typeof to === "string" ? to.trim() : "";
      return trimmed
        ? { ok: true, to: trimmed }
        : { ok: false, error: new Error(`${label} requires target`) };
    },
  };
}

function createAllowlistAwareStubOutbound(label: string): ChannelOutboundAdapter {
  return {
    deliveryMode: "gateway",
    resolveTarget: ({ to, allowFrom }) => {
      const trimmed = typeof to === "string" ? to.trim() : "";
      if (!trimmed) {
        return { ok: false, error: new Error(`${label} requires target`) };
      }
      if (allowFrom && allowFrom.length > 0 && !allowFrom.includes(trimmed)) {
        return { ok: false, error: new Error(`${label} target blocked`) };
      }
      return { ok: true, to: trimmed };
    },
  };
}

const normalizeTelegramTargetForDeliveryTest = vi.fn((raw: string): string | undefined => {
  const target = parseTelegramTargetForTest(raw);
  if (!target.chatId) {
    return undefined;
  }
  const normalizedTo = target.chatId.toLowerCase();
  return target.messageThreadId == null
    ? `telegram:${normalizedTo}`
    : `telegram:${normalizedTo}:topic:${target.messageThreadId}`;
});

beforeEach(() => {
  resetPluginRuntimeStateForTest();
  extractDeliveryInfoMock.mockReset();
  extractDeliveryInfoMock.mockReturnValue({ deliveryContext: undefined, threadId: undefined });
  normalizeTelegramTargetForDeliveryTest.mockClear();
  vi.mocked(resolveOutboundTarget).mockReset();
  vi.mocked(loadSessionEntry).mockReset().mockReturnValue(undefined);
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "forum",
        plugin: createOutboundTestPlugin({
          id: "forum",
          outbound: createStubOutbound("Forum"),
          messaging: forumMessagingForTest,
        }),
        source: "test",
      },
      {
        pluginId: "telegram",
        plugin: createOutboundTestPlugin({
          id: "telegram",
          outbound: createStubOutbound("Telegram"),
          messaging: {
            ...telegramMessagingForTest,
            normalizeTarget: normalizeTelegramTargetForDeliveryTest,
          },
        }),
        source: "test",
      },
      {
        pluginId: "alpha",
        plugin: {
          ...createOutboundTestPlugin({
            id: "alpha",
            outbound: createAllowlistAwareStubOutbound("Alpha"),
          }),
          config: {
            listAccountIds: () => [],
            resolveAccount: () => ({}),
            resolveAllowFrom: ({ cfg }: { cfg: OpenClawConfig }) =>
              (cfg.channels?.alpha as { allowFrom?: string[] } | undefined)?.allowFrom,
          },
        },
        source: "test",
      },
    ]),
  );
});

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

function makeCfg(overrides?: Partial<OpenClawConfig>): OpenClawConfig {
  return {
    bindings: [],
    channels: {},
    ...overrides,
  };
}

function makeForumBoundCfg(accountId = "account-b"): OpenClawConfig {
  return makeCfg({
    bindings: [
      {
        agentId: AGENT_ID,
        match: { channel: "forum", accountId },
      },
    ],
  });
}

function setSingleOutboundTestPlugin(
  params: Parameters<typeof createOutboundTestPlugin>[0],
  overrides: Partial<ReturnType<typeof createOutboundTestPlugin>> = {},
) {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: params.id,
        source: "test",
        plugin: { ...createOutboundTestPlugin(params), ...overrides },
      },
    ]),
  );
}

const AGENT_ID = "agent-b";
const DEFAULT_TARGET = {
  channel: "forum" as const,
  to: "room:default",
};

function sessionEntry(context: DeliveryContext): SessionEntry {
  return {
    sessionId: "session",
    updatedAt: 1000,
    delivery: normalizeSessionDeliveryState({ context }),
  };
}

function setSessionStore(store: Record<string, SessionEntry>) {
  vi.mocked(loadSessionEntry).mockImplementation(({ sessionKey }) => store[sessionKey]);
}

function setLastSessionEntry(context: DeliveryContext) {
  setSessionStore({ "agent:test:main": sessionEntry(context) });
}

async function resolveLastTarget(cfg: OpenClawConfig) {
  return resolveDeliveryTarget(cfg, AGENT_ID, { channel: "last" });
}

describe("resolveDeliveryTarget", () => {
  // Regression #91613: the shared main bucket can belong to another conversation.
  it("refuses keyless delivery inherited from the shared main recipient", async () => {
    setLastSessionEntry({
      channel: "alpha",
      to: "room-allowed",
    });

    const result = await resolveLastTarget(makeCfg({ channels: { alpha: { allowFrom: [] } } }));

    expect(result.channel).toBe("alpha");
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      error: expect.objectContaining({ message: expect.stringContaining("wrong room") }),
    });
  });

  it("applies allowFrom rerouting to dry-run delivery previews", async () => {
    setLastSessionEntry({
      channel: "alpha",
      to: "room-denied",
    });

    const cfg = makeCfg({ channels: { alpha: { allowFrom: ["room-allowed"] } } });
    const result = await resolveDeliveryTarget(
      cfg,
      AGENT_ID,
      {
        channel: "last",
        to: undefined,
      },
      { dryRun: true },
    );

    expect(result).toMatchObject({ ok: true, channel: "alpha", to: "room-allowed" });
  });

  it("falls back to the session for a whitespace-only account", async () => {
    setLastSessionEntry({
      channel: "forum",
      to: "room:other-conversation",
      accountId: "session-account",
    });

    const result = await resolveDeliveryTarget(makeForumBoundCfg(), AGENT_ID, {
      channel: "forum",
      to: "room:ops",
      accountId: "   ",
    });

    expect(result.ok).toBe(true);
    expect(result.accountId).toBe("session-account");
    expect(result.to).toBe("room:ops");
  });

  it("surfaces target resolver exceptions instead of treating raw names as resolved", async () => {
    setSingleOutboundTestPlugin(
      {
        id: "alpha",
        outbound: createStubOutbound("Alpha"),
        messaging: { targetPrefixes: ["alpha"] },
        capabilities: { chatTypes: ["group"] },
      },
      {
        directory: {
          listGroups: async () => {
            throw new Error("directory auth failed");
          },
        },
      },
    );

    const result = await resolveDeliveryTarget(makeCfg(), AGENT_ID, {
      channel: "alpha",
      to: "ops",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected target resolver error");
    }
    expect(result.error.message).toContain("directory auth failed");
  });

  it("resolves cron reserved explicit targets through directory entries", async () => {
    const listGroups = vi.fn(async () => [
      {
        kind: "group",
        id: "-1002458651455",
        name: "current",
        handle: "@current",
      } satisfies ChannelDirectoryEntry,
    ]);
    setSingleOutboundTestPlugin(
      {
        id: "telegram",
        outbound: createStubOutbound("Telegram"),
        capabilities: { chatTypes: ["direct", "group", "channel"] },
        messaging: {
          ...telegramMessagingForTest,
          normalizeTarget: normalizeTelegramTargetForDeliveryTest,
          targetResolver: {
            reservedLiterals: ["current", "self", "this", "me"],
            hint: "<chatId>",
          },
        },
      },
      { directory: { listGroups } },
    );

    const result = await resolveDeliveryTarget(makeCfg(), AGENT_ID, {
      channel: "telegram",
      to: "current",
    });

    expect(result.ok).toBe(true);
    expect(result.to).toBe("-1002458651455");
    expect(result.threadId).toBeUndefined();
  });

  it("ignores stale previous-route parse failures for explicit cron targets", async () => {
    setLastSessionEntry({
      channel: "alpha",
      to: "bad:stored:target",
      threadId: "old-thread",
    });
    setSingleOutboundTestPlugin({
      id: "alpha",
      outbound: createStubOutbound("Alpha"),
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
    });

    const result = await resolveDeliveryTarget(makeCfg(), AGENT_ID, {
      channel: "alpha",
      to: "alpha:room-a",
    });

    expect(result.ok).toBe(true);
    expect(result.to).toBe("room-a");
    expect(result.threadId).toBeUndefined();
  });

  it("falls back to the runtime target resolver when the channel plugin is not already loaded", async () => {
    setSingleOutboundTestPlugin({ id: "alpha", outbound: createStubOutbound("Alpha") });
    vi.mocked(resolveOutboundTarget).mockResolvedValueOnce({ ok: true, to: "room:default" });

    const cfg = makeCfg();
    const result = await resolveDeliveryTarget(cfg, AGENT_ID, {
      channel: "forum",
      to: "room:default",
    });

    expect(result).toMatchObject({
      ok: true,
      channel: "forum",
      to: "room:default",
      accountId: undefined,
      threadId: undefined,
      mode: "explicit",
    });
  });

  it("returns an unresolved target when loaded target resolution throws", async () => {
    setSingleOutboundTestPlugin({
      id: "alpha",
      outbound: {
        deliveryMode: "gateway",
        resolveTarget: () => {
          throw new Error("target normalizer exploded");
        },
      },
    });

    const result = await resolveDeliveryTarget(makeCfg(), AGENT_ID, {
      channel: "alpha",
      to: "room:default",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected invalid delivery target");
    }
    expect(result.error.message).toContain("Invalid delivery target: target normalizer exploded");
  });

  it("returns an unresolved target when the shared prefix guard rejects the explicit target", async () => {
    const resolveTarget = vi.fn(() => ({ ok: true as const, to: "telegram:1234567890" }));
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "alpha",
          plugin: createOutboundTestPlugin({
            id: "alpha",
            outbound: {
              deliveryMode: "gateway",
              resolveTarget,
            },
          }),
          source: "test",
        },
        {
          pluginId: "telegram",
          plugin: createOutboundTestPlugin({
            id: "telegram",
            outbound: createStubOutbound("Telegram"),
            messaging: telegramMessagingForTest,
          }),
          source: "test",
        },
      ]),
    );

    const result = await resolveDeliveryTarget(makeCfg(), AGENT_ID, {
      channel: "alpha",
      to: "telegram:1234567890",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected invalid delivery target");
    }
    expect(result.error.message).toContain("belongs to telegram, not alpha");
    expect(resolveTarget).not.toHaveBeenCalled();
  });

  it("drops session threadId when destination does not match the previous recipient", async () => {
    setLastSessionEntry({
      channel: "forum",
      to: "room:other",
      threadId: "thread-1",
    });

    const result = await resolveDeliveryTarget(makeCfg(), AGENT_ID, DEFAULT_TARGET);
    expect(result.threadId).toBeUndefined();
  });

  it("does not carry a Telegram topic threadId to a bare explicit group target", async () => {
    setLastSessionEntry({
      channel: "telegram",
      to: "-100200300:topic:77",
      threadId: "77",
    });
    normalizeTelegramTargetForDeliveryTest.mockClear();

    const result = await resolveDeliveryTarget(makeCfg(), AGENT_ID, {
      channel: "telegram",
      to: "-100200300",
    });

    expect(result.ok).toBe(true);
    expect(result.to).toBe("-100200300");
    expect(result.threadId).toBeUndefined();
    expect(normalizeTelegramTargetForDeliveryTest).toHaveBeenCalledWith("-100200300");
  });

  it("keeps session threadId when destination matches the previous recipient", async () => {
    setLastSessionEntry({
      channel: "forum",
      to: "room:default",
      threadId: "thread-2",
    });

    const result = await resolveDeliveryTarget(makeCfg(), AGENT_ID, DEFAULT_TARGET);
    expect(result.threadId).toBe("thread-2");
  });

  it("uses single configured channel when neither explicit nor session channel exists", async () => {
    const result = await resolveLastTarget(makeCfg());
    expect(result.channel).toBe("alpha");
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected unresolved delivery target");
    }
    expect(result.error.message).toContain("requires target");
  });

  it("rejects provider-prefixed explicit targets without a recipient", async () => {
    const result = await resolveDeliveryTarget(makeCfg(), AGENT_ID, {
      channel: "last",
      to: "telegram:",
    });

    expect(result.ok).toBe(false);
    expect(result.channel).toBe("telegram");
    expect(result.to).toBeUndefined();
    if (result.ok) {
      throw new Error("expected missing target error");
    }
    expect(result.error.message).toContain("Target is required");
  });

  it("returns an error when channel selection is ambiguous", async () => {
    vi.mocked(resolveMessageChannelSelection).mockRejectedValueOnce(
      new Error("Channel is required when multiple channels are configured: alpha, forum"),
    );

    const result = await resolveLastTarget(makeCfg());
    expect(result.channel).toBeUndefined();
    expect(result.to).toBeUndefined();
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected ambiguous channel selection error");
    }
    expect(result.error.message).toContain("Channel is required");
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
    setSessionStore({
      "agent:test:thread:42": sessionEntry({
        channel: "alpha",
        to: "room-lowercase",
        threadId: "thread-old",
      }),
    });

    const result = await resolveDeliveryTarget(makeCfg(), AGENT_ID, {
      channel: "last",
      sessionKey: "agent:test:thread:42",
      to: undefined,
    });

    expect(result).toMatchObject({
      ok: true,
      channel: "alpha",
      to: "RoomMixedCase",
      accountId: "primary",
      threadId: "thread-stored",
    });
  });

  it("scopes unqualified stored delivery lookups to the job agent", async () => {
    extractDeliveryInfoMock.mockImplementation((sessionKey: string) => ({
      deliveryContext: {
        channel: "alpha",
        to: sessionKey === "agent:agent-b:main" ? "ops-room" : "default-room",
      },
      threadId: undefined,
    }));

    const result = await resolveDeliveryTarget(makeCfg(), AGENT_ID, {
      channel: "last",
      sessionKey: "main",
      to: undefined,
    });

    expect(extractDeliveryInfoMock).toHaveBeenCalledWith("agent:agent-b:main", {
      cfg: expect.any(Object),
      agentId: AGENT_ID,
    });
    expect(result).toMatchObject({
      ok: true,
      channel: "alpha",
      to: "ops-room",
    });
  });

  it("resolves plugin default targets through the modern target route", async () => {
    setSingleOutboundTestPlugin(
      {
        id: "telegram",
        outbound: createStubOutbound("Telegram"),
        messaging: {
          ...telegramMessagingForTest,
          normalizeTarget: normalizeTelegramTargetForDeliveryTest,
        },
      },
      {
        config: {
          listAccountIds: () => [],
          resolveAccount: () => ({}),
          resolveDefaultTo: () => "-100200300:77",
        },
      },
    );

    const result = await resolveDeliveryTarget(makeCfg(), AGENT_ID, {
      channel: "telegram",
      to: undefined,
    });

    expect(result.ok).toBe(true);
    expect(result.to).toBe("-100200300");
    expect(result.threadId).toBe(77);
  });

  it("keeps explicit delivery threadId when stripping telegram :topic: targets", async () => {
    const result = await resolveDeliveryTarget(makeCfg(), AGENT_ID, {
      channel: "telegram",
      to: "63448508:topic:1008013",
      threadId: "42",
    });

    expect(result.ok).toBe(true);
    expect(result.to).toBe("63448508");
    expect(result.threadId).toBe("42");
  });
});
