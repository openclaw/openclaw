import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as preparedModelCatalog from "../../agents/prepared-model-catalog.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { applyModelOverrideToSessionEntry } from "../../sessions/model-overrides.js";
import { buildStatusReplyParts } from "../../status/status-text.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import {
  createNativeModelCatalog,
  createNativeSlashFixture,
  nativeCommand,
} from "./get-reply-native-slash-fast-path.test-fixtures.js";
import type { buildTestCtx } from "./test-ctx.js";

type NativeStatusSelectionCase = {
  source?: "user" | "auto";
  channelModel?: string;
  deliveryChannel?: string;
  directSenderId?: string;
  directUserId?: string;
  expected?: string;
  groupId?: string;
  locked?: boolean;
  modelParentSessionKey?: string;
  preparedModel?: string;
  preparedProvider?: string;
  topicName?: string;
  overrideKey?: string;
};

const buildStatusReplyMock = vi.hoisted(() => vi.fn());

vi.mock("./commands-status.js", () => ({
  buildStatusReply: (...args: unknown[]) => buildStatusReplyMock(...args),
}));

const { maybeResolveNativeSlashCommandFastReply } =
  await import("./get-reply-native-slash-fast-path.js");

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

let fixture: ReturnType<typeof createNativeSlashFixture>;
function runStatus(
  ctx: Parameters<typeof buildTestCtx>[0],
  overrides: Partial<Parameters<typeof fixture.run>[0]>,
) {
  return fixture.run({
    ctx: nativeCommand("/status", {
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "group",
      ...ctx,
    }),
    ...overrides,
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  fixture = createNativeSlashFixture(
    path.join(tempDirs.make("openclaw-native-status-"), "sessions.json"),
    maybeResolveNativeSlashCommandFastReply,
  );
  vi.stubEnv("OPENCLAW_TEST_FAST", "1");
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(createSessionConversationTestRegistry());
  vi.spyOn(preparedModelCatalog, "readPreparedModelCatalog").mockResolvedValue(
    createNativeModelCatalog(true),
  );
  buildStatusReplyMock.mockReset().mockResolvedValue({ text: "selected model status" });
});

it.each<[string, NativeStatusSelectionCase]>([
  ["user override", { source: "user", expected: "openai/gpt-5.5" }],
  ["automatic fallback", { source: "auto", expected: "openai/gpt-5.5" }],
  ["channel override", {}],
  ["configured channel model alias", { channelModel: "Fable" }],
  ["current command channel over stale session delivery", { deliveryChannel: "discord" }],
  ["parent group override for a topic", { groupId: "123:topic:77", topicName: "Planning" }],
  [
    "thread-only model parent session override",
    {
      groupId: "unmatched-thread",
      modelParentSessionKey: "agent:main:telegram:group:123:thread:77",
    },
  ],
  [
    "group-name override for a topic",
    {
      groupId: "123:topic:77",
      topicName: "Planning",
      overrideKey: "Project Team",
      channelModel: "xai/grok-4.3",
      expected: "xai/grok-4.3",
    },
  ],
  ["native direct peer override before wildcard", { directUserId: "native-peer-42" }],
  ["current direct sender override before wildcard", { directSenderId: "live-peer-43" }],
  [
    "current direct sender over another channel's persisted peer",
    {
      deliveryChannel: "discord",
      directUserId: "stale-discord-peer",
      directSenderId: "live-telegram-peer",
    },
  ],
  ["locked model selection", { locked: true, expected: "openai/gpt-5.5" }],
  [
    "prepared non-default heartbeat or fallback model",
    { preparedProvider: "xai", preparedModel: "grok-4.3", expected: "xai/grok-4.3" },
  ],
])("preserves canonical native /status %s", async (_, testCase) => {
  const targetSessionKey = testCase.topicName
    ? "agent:main:telegram:group:123:topic:77"
    : "agent:main:main";
  const {
    channelModel = "anthropic/claude-fable-5",
    deliveryChannel = "telegram",
    directSenderId,
    directUserId,
    expected = "anthropic/claude-fable-5",
    groupId = "123",
    locked = false,
    modelParentSessionKey,
    preparedModel = "gpt-5.5",
    preparedProvider = "openai",
    source,
    topicName,
  } = testCase;
  const isDirect = directUserId !== undefined || directSenderId !== undefined;
  const overrideKey = testCase.overrideKey ?? directSenderId ?? directUserId ?? "123";
  const conflictingDirectUserId =
    directSenderId !== undefined && directUserId !== undefined ? directUserId : undefined;
  await fixture.write(
    {
      sessionId: "status-session",
      updatedAt: Date.now(),
      contextTokens: 1_000_000,
      delivery: normalizeSessionDeliveryState({
        context: { channel: deliveryChannel },
        origin: directUserId
          ? { provider: deliveryChannel, nativeDirectUserId: directUserId }
          : undefined,
      }),
      groupId: isDirect ? undefined : groupId,
      subject: topicName ? "Project Team" : undefined,
      topicName: topicName ? "Previous" : undefined,
      modelSelectionLocked: locked || undefined,
      providerOverride: source ? "anthropic" : undefined,
      modelOverride: source ? "claude-fable-5" : undefined,
      modelOverrideSource: source,
      modelOverrideFallbackOriginProvider: source === "auto" ? "openai" : undefined,
      modelOverrideFallbackOriginModel: source === "auto" ? "gpt-5.5" : undefined,
      modelProvider: source === "auto" ? "openai" : undefined,
      model: source === "auto" ? "gpt-5.5" : undefined,
    },
    targetSessionKey,
  );

  const result = await runStatus(
    {
      ChatType: isDirect ? "direct" : "group",
      GroupSubject: topicName ? "Project Team" : undefined,
      TopicName: topicName,
      MessageThreadId: topicName ? 77 : undefined,
      IsForum: topicName ? true : undefined,
      ...(!isDirect ? { From: `telegram:group:${groupId}` } : {}),
      ...(directSenderId ? { From: `telegram:${directSenderId}` } : {}),
      OriginatingTo: !isDirect ? `telegram:${groupId}` : undefined,
      SenderId: directSenderId,
      ModelParentSessionKey: modelParentSessionKey,
      SessionKey: "telegram:slash:123",
      CommandTargetSessionKey: targetSessionKey,
    },
    {
      cfg: fixture.config({
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.5" },
            modelPolicy: {
              allow: source ? ["openai/*"] : ["openai/*", "anthropic/*", "xai/*"],
            },
            models: {
              "anthropic/claude-fable-5": {
                alias: "Fable",
                params: { thinking: "high", fastMode: true },
              },
            },
          },
        },
        channels: {
          modelByChannel: {
            telegram: {
              [overrideKey]: channelModel,
              ...(conflictingDirectUserId ? { [conflictingDirectUserId]: "xai/grok-4.3" } : {}),
              "*": "openai/gpt-5.5",
            },
            discord: { "123": "openai/gpt-5.5" },
          },
        },
      } as OpenClawConfig),
      aliasIndex: {
        byKey: new Map(),
        byAlias: new Map([
          ["fable", { alias: "Fable", ref: { provider: "anthropic", model: "claude-fable-5" } }],
        ]),
      },
      provider: preparedProvider,
      model: preparedModel,
    },
  );

  const [expectedProvider, expectedModel] = expected.split("/");
  const statusCall = buildStatusReplyMock.mock.calls[0]?.[0];
  expect(statusCall).toMatchObject({ provider: expectedProvider, model: expectedModel });
  // The real-render sibling covers catalog plumbing; this matrix owns route selection.
  if (expectedProvider === "anthropic") {
    await expect(statusCall.resolveDefaultThinkingLevel()).resolves.toBe("high");
  }
  if (source) {
    expect(fixture.read(targetSessionKey)).toMatchObject({
      providerOverride: "anthropic",
      modelOverride: "claude-fable-5",
      modelOverrideSource: source,
    });
  } else {
    expect(fixture.read(targetSessionKey)?.providerOverride).toBeUndefined();
    expect(fixture.read(targetSessionKey)?.modelOverride).toBeUndefined();
  }
  expect(result).toMatchObject({ reply: { text: "selected model status" } });
  if (topicName) {
    expect(fixture.read(targetSessionKey)).toMatchObject({
      sessionId: "status-session",
      subject: "Project Team",
      topicName: "Planning",
    });
  }
});

it.each([false, true])(
  "renders parent selection with explicit Default=%s without changing stored pins",
  async (explicitDefault) => {
    buildStatusReplyMock.mockImplementation(
      async (params: Parameters<typeof buildStatusReplyParts>[0]) =>
        buildStatusReplyParts({
          ...params,
          statusChannel: "telegram",
          resolvedHarness: "openclaw",
          pluginHealthLineOverride: "",
          modelAuthOverride: "api-key",
          activeModelAuthOverride: "api-key",
          includeTranscriptUsage: false,
        }),
    );
    const parentSessionKey = "agent:main:telegram:group:parent";
    const sessionKey = "agent:main:telegram:group:parent:topic:77";
    const parent = {
      sessionId: "parent",
      updatedAt: Date.now(),
      providerOverride: "anthropic",
      modelOverride: "claude-fable-5",
      modelOverrideSource: "user" as const,
    };
    await fixture.write(parent, parentSessionKey);
    const parentBefore = fixture.read(parentSessionKey);
    const child: SessionEntry = {
      sessionId: "child",
      updatedAt: Date.now(),
      parentSessionKey,
    };
    if (explicitDefault) {
      child.providerOverride = "xai";
      child.modelOverride = "stale-child-model";
      child.modelOverrideSource = "user";
      applyModelOverrideToSessionEntry({
        entry: child,
        selection: { provider: "openai", model: "gpt-5.5", isDefault: true },
        explicitDefaultSelection: true,
      });
    }
    await fixture.write(child, sessionKey);
    const result = await runStatus(
      {
        ChatType: "group",
        SessionKey: "telegram:slash:parent",
        CommandTargetSessionKey: sessionKey,
      },
      {
        cfg: fixture.config({
          agents: { defaults: { model: "openai/gpt-5.5", modelPolicy: { allow: ["openai/*"] } } },
          ...(explicitDefault
            ? {}
            : { channels: { modelByChannel: { telegram: { "*": "google/channel-model" } } } }),
        } as OpenClawConfig),
      },
    );
    expect(result).toMatchObject({
      handled: true,
      reply: {
        text: expect.stringContaining(
          `Model: ${explicitDefault ? "openai/gpt-5.5" : "anthropic/claude-fable-5"}`,
        ),
      },
    });
    expect(fixture.read(parentSessionKey)).toEqual(parentBefore);
    const persistedChild = fixture.read(sessionKey);
    expect(persistedChild).toMatchObject({ parentSessionKey });
    expect(persistedChild?.providerOverride).toBeUndefined();
    expect(persistedChild?.modelOverride).toBeUndefined();
    if (explicitDefault) {
      expect(persistedChild?.modelOverrideSource).toBe("default");
    }
  },
);
