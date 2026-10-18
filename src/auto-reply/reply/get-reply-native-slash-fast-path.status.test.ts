import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as preparedModelCatalog from "../../agents/prepared-model-catalog.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { applyModelOverrideToSessionEntry } from "../../sessions/model-overrides.js";
import { buildStatusReplyParts } from "../../status/status-text.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { markCompleteReplyConfig } from "./get-reply-fast-path.test-support.js";
import { buildTestCtx } from "./test-ctx.js";
import type { TypingController } from "./typing.js";

type NativeStatusSelectionCase = {
  selection: string;
  source?: "user" | "auto";
  channelModel?: string;
  deliveryChannel?: string;
  directSenderId?: string;
  directUserId?: string;
  expectedModel?: string;
  expectedProvider?: string;
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

const createTypingController = (): TypingController => ({
  onReplyStart: async () => {},
  startTypingLoop: async () => {},
  startTypingOnText: async () => {},
  refreshTypingTtl: () => {},
  isActive: () => false,
  markRunComplete: () => {},
  markDispatchIdle: () => {},
  cleanup: vi.fn(),
});

type StatusParams = Parameters<typeof maybeResolveNativeSlashCommandFastReply>[0];
function runStatus(
  ctx: Parameters<typeof buildTestCtx>[0],
  overrides: Pick<StatusParams, "cfg"> & Partial<Omit<StatusParams, "ctx" | "cfg">>,
) {
  return maybeResolveNativeSlashCommandFastReply({
    ctx: buildTestCtx({
      Body: "/status",
      CommandBody: "/status",
      CommandSource: "native",
      CommandAuthorized: true,
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "group",
      CommandTurn: {
        kind: "native",
        source: "native",
        authorized: true,
        commandName: "status",
        body: "/status",
      },
      ...ctx,
    }),
    agentId: "main",
    agentDir: "/tmp/agent",
    agentCfg: undefined,
    commandAuthorized: true,
    defaultProvider: "openai",
    defaultModel: "gpt-5.5",
    provider: "openai",
    model: "gpt-5.5",
    aliasIndex: { byAlias: new Map(), byKey: new Map() },
    workspaceDir: "/tmp/workspace",
    typing: createTypingController(),
    ...overrides,
  });
}

function channelSelection(
  selection: string,
  overrides: Partial<NativeStatusSelectionCase> = {},
): NativeStatusSelectionCase {
  return {
    selection,
    expectedProvider: "anthropic",
    expectedModel: "claude-fable-5",
    ...overrides,
  };
}

describe("native /status channel model routing", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createSessionConversationTestRegistry());
    vi.spyOn(preparedModelCatalog, "readPreparedModelCatalog").mockResolvedValue([
      {
        id: "gpt-5.5",
        name: "GPT",
        provider: "openai",
        contextWindow: 400_000,
        reasoning: false,
      },
      {
        id: "claude-fable-5",
        name: "Fable",
        provider: "anthropic",
        contextWindow: 1_000_000,
        reasoning: true,
      },
    ]);
    buildStatusReplyMock.mockReset();
    buildStatusReplyMock.mockResolvedValue({ text: "selected model status" });
  });

  const statusSelectionCases: NativeStatusSelectionCase[] = [
    { selection: "user override", source: "user" },
    { selection: "automatic fallback", source: "auto" },
    channelSelection("channel override"),
    channelSelection("configured channel model alias", {
      channelModel: "Fable",
    }),
    channelSelection("current command channel over stale session delivery", {
      deliveryChannel: "discord",
    }),
    channelSelection("parent group override for a topic", {
      groupId: "123:topic:77",
      topicName: "Planning",
    }),
    channelSelection("thread-only model parent session override", {
      groupId: "unmatched-thread",
      modelParentSessionKey: "agent:main:telegram:group:123:thread:77",
    }),
    {
      selection: "group-name override for a topic",
      groupId: "123:topic:77",
      topicName: "Planning",
      overrideKey: "Project Team",
      channelModel: "xai/grok-4.3",
      expectedProvider: "xai",
      expectedModel: "grok-4.3",
    },
    channelSelection("native direct peer override before wildcard", {
      directUserId: "native-peer-42",
    }),
    channelSelection("current direct sender override before wildcard", {
      directSenderId: "live-peer-43",
    }),
    channelSelection("current direct sender over another channel's persisted peer", {
      deliveryChannel: "discord",
      directUserId: "stale-discord-peer",
      directSenderId: "live-telegram-peer",
    }),
    {
      selection: "locked model selection",
      locked: true,
    },
    {
      selection: "prepared non-default heartbeat or fallback model",
      preparedProvider: "xai",
      preparedModel: "grok-4.3",
      expectedProvider: "xai",
      expectedModel: "grok-4.3",
    },
  ];

  it.each(statusSelectionCases)(
    "preserves canonical native /status $selection",
    async (testCase) => {
      const targetSessionKey = testCase.topicName
        ? "agent:main:telegram:group:123:topic:77"
        : "agent:main:main";
      const storePath = path.join(tempDirs.make("openclaw-native-status-"), "sessions.json");
      const {
        channelModel = "anthropic/claude-fable-5",
        deliveryChannel = "telegram",
        directSenderId,
        directUserId,
        expectedModel = "gpt-5.5",
        expectedProvider = "openai",
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
      await replaceSessionEntry(
        { agentId: "main", sessionKey: targetSessionKey, storePath },
        {
          sessionId: "status-session",
          updatedAt: Date.now(),
          contextTokens: 1_000_000,
          delivery: normalizeSessionDeliveryState({
            context: { channel: deliveryChannel },
            ...(directUserId
              ? { origin: { provider: deliveryChannel, nativeDirectUserId: directUserId } }
              : {}),
          }),
          ...(isDirect ? {} : { groupId }),
          ...(topicName ? { subject: "Project Team", topicName: "Previous" } : {}),
          ...(locked ? { modelSelectionLocked: true } : {}),
          ...(source
            ? {
                providerOverride: "anthropic",
                modelOverride: "claude-fable-5",
                modelOverrideSource: source,
                ...(source === "auto"
                  ? {
                      modelOverrideFallbackOriginProvider: "openai",
                      modelOverrideFallbackOriginModel: "gpt-5.5",
                      modelProvider: "openai",
                      model: "gpt-5.5",
                    }
                  : {}),
              }
            : {}),
        },
      );

      const result = await runStatus(
        {
          ChatType: isDirect ? "direct" : "group",
          ...(topicName
            ? {
                GroupSubject: "Project Team",
                TopicName: topicName,
                MessageThreadId: 77,
                IsForum: true,
              }
            : {}),
          ...(!isDirect
            ? { From: `telegram:group:${groupId}`, OriginatingTo: `telegram:${groupId}` }
            : {}),
          ...(directSenderId
            ? { From: `telegram:${directSenderId}`, SenderId: directSenderId }
            : {}),
          ...(modelParentSessionKey ? { ModelParentSessionKey: modelParentSessionKey } : {}),
          SessionKey: "telegram:slash:123",
          CommandTargetSessionKey: targetSessionKey,
        },
        {
          cfg: markCompleteReplyConfig({
            session: { store: storePath },
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
              [
                "fable",
                { alias: "Fable", ref: { provider: "anthropic", model: "claude-fable-5" } },
              ],
            ]),
          },
          provider: preparedProvider,
          model: preparedModel,
        },
      );

      const statusCall = buildStatusReplyMock.mock.calls[0]?.[0];
      expect(statusCall).toMatchObject({ provider: expectedProvider, model: expectedModel });
      expect(statusCall.thinkingCatalog).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            provider: "anthropic",
            id: "claude-fable-5",
            contextWindow: 1_000_000,
          }),
        ]),
      );
      if (expectedProvider === "anthropic") {
        await expect(statusCall.resolveDefaultThinkingLevel()).resolves.toBe("high");
      }
      if (source) {
        expect(statusCall.sessionEntry).toMatchObject({
          providerOverride: "anthropic",
          modelOverride: "claude-fable-5",
          modelOverrideSource: source,
        });
      } else {
        expect(statusCall.sessionEntry).not.toHaveProperty("providerOverride");
        expect(statusCall.sessionEntry).not.toHaveProperty("modelOverride");
      }
      expect(result).toMatchObject({ reply: { text: "selected model status" } });
      if (topicName) {
        expect(
          loadSessionEntry({ agentId: "main", sessionKey: targetSessionKey, storePath }),
        ).toMatchObject({
          sessionId: "status-session",
          subject: "Project Team",
          topicName: "Planning",
        });
      }
    },
  );

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
      const storePath = path.join(tempDirs.make("openclaw-native-status-parent-"), "sessions.json");
      const parentSessionKey = "agent:main:telegram:group:parent";
      const sessionKey = "agent:main:telegram:group:parent:topic:77";
      const parent = {
        sessionId: "parent",
        updatedAt: Date.now(),
        providerOverride: "anthropic",
        modelOverride: "claude-fable-5",
        modelOverrideSource: "user" as const,
      };
      await replaceSessionEntry(
        { agentId: "main", storePath, sessionKey: parentSessionKey },
        parent,
      );
      const parentBefore = loadSessionEntry({
        agentId: "main",
        storePath,
        sessionKey: parentSessionKey,
      });
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
      await replaceSessionEntry({ agentId: "main", storePath, sessionKey }, child);
      const result = await runStatus(
        {
          ChatType: "group",
          SessionKey: "telegram:slash:parent",
          CommandTargetSessionKey: sessionKey,
        },
        {
          cfg: markCompleteReplyConfig({
            session: { store: storePath },
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
      expect(
        loadSessionEntry({ agentId: "main", storePath, sessionKey: parentSessionKey }),
      ).toEqual(parentBefore);
      const persistedChild = loadSessionEntry({ agentId: "main", storePath, sessionKey });
      expect(persistedChild).toMatchObject({ parentSessionKey });
      expect(persistedChild?.providerOverride).toBeUndefined();
      expect(persistedChild?.modelOverride).toBeUndefined();
      if (explicitDefault) {
        expect(persistedChild?.modelOverrideSource).toBe("default");
      }
    },
  );
});
