import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  createPluginRecord,
  createPluginRegistry,
  createPluginRuntimeMock,
  resetPluginRuntimeStateForTest,
  type PluginRecord,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  resolveAmbientTranscriptWatermarkKey,
  resolveStorePath,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { telegramPlugin, type TelegramBotMessage as Message } from "../extensions/telegram/api.js";
import { setTelegramRuntime } from "../extensions/telegram/runtime-api.js";
import {
  clearTelegramRuntimeForTest,
  createTelegramMessageCache,
  resetTelegramMessageCacheForTest,
  resolveTelegramMessageCacheScope,
} from "../extensions/telegram/test-api.js";
import { createMessageTool } from "../src/agents/tools/message-tool-execution.js";
import { dispatchChannelMessageAction } from "../src/channels/plugins/message-action-dispatch.js";
import { getPluginInstance } from "../src/plugins/plugin-instance-scope.js";

const CHAT = -1001;
const TOPIC = 77;
const SESSION = "agent:main:telegram:group:-1001:topic:77";

let testState: OpenClawTestState;
let cfg: OpenClawConfig;
let afterStoreRead: (() => void) | undefined;
let sessionCurrent: boolean;
let pluginRecord: PluginRecord;

function context(
  overrides: Partial<ChannelMessageActionContext> = {},
): ChannelMessageActionContext {
  return {
    channel: "telegram",
    action: "read",
    cfg,
    params: {},
    accountId: "default",
    requesterAccountId: "default",
    requesterSenderId: "1",
    sessionKey: SESSION,
    conversationReadOrigin: "delegated",
    toolContext: {
      currentChannelProvider: "telegram",
      currentChatType: "group",
      currentChannelId: String(CHAT),
      currentThreadTs: String(TOPIC),
      currentMessageId: "150",
    },
    assertDirectAdapterHandoff: () => {
      if (!sessionCurrent) {
        throw new Error("Session authority was revoked");
      }
    },
    ...overrides,
  };
}

function cache() {
  return createTelegramMessageCache({
    scope: resolveTelegramMessageCacheScope(
      resolveStorePath(cfg.session?.store, { agentId: "main" }),
    ),
  });
}

async function record(
  id: number,
  options: {
    threadId?: number;
    senderId?: number;
    eligible?: boolean;
    body?: string;
    accountId?: string;
    extra?: Partial<Message>;
  } = {},
) {
  const threadId = options.threadId ?? TOPIC;
  return await cache().record({
    accountId: options.accountId ?? "default",
    chatId: CHAT,
    historyEligible: options.eligible ?? true,
    providerObservedThread: threadId > 0 ? { scope: "forum", id: threadId } : { scope: "none" },
    msg: {
      message_id: id,
      date: 1_700_000_000 + id,
      chat: { id: CHAT, type: "supergroup", title: "Synthetic history", is_forum: true },
      from: {
        id: options.senderId ?? 1,
        is_bot: options.senderId === 999,
        first_name: "Participant",
      },
      text: options.body ?? `Discussion ${id}`,
      ...(threadId > 0 ? { message_thread_id: threadId, is_topic_message: true } : {}),
      ...options.extra,
    } as Message,
  });
}

async function read(
  params: Record<string, unknown> = {},
  overrides: Partial<ChannelMessageActionContext> = {},
) {
  return await dispatchChannelMessageAction({ ...context(overrides), params });
}

beforeEach(async () => {
  resetTelegramMessageCacheForTest();
  resetPluginStateStoreForTests();
  resetPluginRuntimeStateForTest();
  testState = await createOpenClawTestState({
    label: "telegram-history-read",
    layout: "state-only",
  });
  cfg = {
    session: { store: testState.statePath("agents", "main", "sessions", "sessions.json") },
    channels: {
      telegram: {
        botToken: "999:synthetic-test-token",
        groupPolicy: "allowlist",
        groupAllowFrom: ["1"],
        groups: { [CHAT]: { requireMention: true } },
      },
    },
  };
  setRuntimeConfigSnapshot(cfg, cfg);
  sessionCurrent = true;
  afterStoreRead = undefined;
  const owner = createPluginRegistry({
    runtime: createPluginRuntimeMock(),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    activateGlobalSideEffects: false,
  });
  pluginRecord = createPluginRecord({ id: "telegram", origin: "bundled" });
  owner.registry.plugins.push(pluginRecord);
  const api = owner.createApi(pluginRecord, { config: cfg, registrationMode: "full" });
  const instance = getPluginInstance(pluginRecord);
  if (!instance) {
    throw new Error("Expected the Telegram registrar to own a plugin instance");
  }
  const state = api.runtime.state;
  const openKeyedStore: typeof state.openKeyedStore = <T>(
    options: Parameters<typeof state.openKeyedStore>[0],
  ) => {
    const store = state.openKeyedStore<T>(options);
    const readRange = store.entriesInKeyRange;
    if (!readRange) {
      throw new Error("Expected the host to support indexed history reads");
    }
    return {
      ...store,
      entriesInKeyRange: async (range: Parameters<typeof readRange>[0]) => {
        const entries = await readRange(range);
        const hook = afterStoreRead;
        afterStoreRead = undefined;
        hook?.();
        return entries;
      },
    };
  };
  const runtime = createPluginRuntimeMock({ state: { ...state, openKeyedStore } });
  setTelegramRuntime(runtime);
  instance.run(() => {
    setTelegramRuntime(runtime);
    api.registerChannel({ plugin: { ...telegramPlugin, status: undefined } });
  });
  setActivePluginRegistry(owner.registry);
});

afterEach(async () => {
  afterStoreRead = undefined;
  resetTelegramMessageCacheForTest();
  clearTelegramRuntimeForTest();
  resetPluginRuntimeStateForTest();
  resetPluginStateStoreForTests();
  clearRuntimeConfigSnapshot();
  await testState.cleanup();
});

describe("Telegram retained history through shared message dispatch", () => {
  it("discovers the shared read schema and pages native IDs with safe attributed results", async () => {
    const tool = createMessageTool({
      config: cfg,
      agentAccountId: "default",
      currentChannelProvider: "telegram",
    });
    expect(
      Value.Check(tool.parameters, {
        action: "read",
        channel: "telegram",
        before: "100",
        limit: 3,
      }),
    ).toBe(true);
    expect(
      Value.Check(tool.parameters, { action: "read", channel: "telegram", messageId: "9" }),
    ).toBe(true);
    for (const id of [9, 10, 99, 100, 150, 151]) {
      await record(id);
    }
    await record(98, { senderId: 2, body: "Not permitted by the current sender allowlist" });
    await record(8, { eligible: false, body: "Unauthenticated legacy context" });
    await record(97, { threadId: 78, body: "Sibling topic" });
    await record(96, { accountId: "other", body: "Sibling account" });

    expect((await read({ limit: 3 }))?.details).toMatchObject({
      messages: [{ messageId: "10" }, { messageId: "99" }, { messageId: "100" }],
      hasMore: true,
      oldestMessageId: "10",
    });
    expect((await read({ before: "10", limit: 3 }))?.details).toMatchObject({
      messages: [
        { messageId: "9", senderId: "1", timestamp: 1_700_000_009_000, body: "Discussion 9" },
      ],
      hasMore: false,
    });
    expect((await read({ after: "99", limit: 3 }))?.details).toMatchObject({
      messages: [{ messageId: "100" }, { messageId: "150" }, { messageId: "151" }],
      hasMore: false,
    });
    expect((await read({ before: "101", after: "8", limit: 2 }))?.details).toMatchObject({
      messages: [{ messageId: "99" }, { messageId: "100" }],
      hasMore: true,
    });
    expect((await read({ before: "99", after: "8", limit: 2 }))?.details).toMatchObject({
      messages: [{ messageId: "9" }, { messageId: "10" }],
      hasMore: false,
    });
    await record(9, {
      body: "An attached chart",
      extra: {
        photo: [{ file_id: "chart-id", file_unique_id: "chart-unique", width: 10, height: 10 }],
      },
    });
    await cache().recordResolvedMedia({
      accountId: "default",
      chatId: CHAT,
      messageId: "9",
      media: {
        id: "cached-chart",
        fileUniqueId: "chart-unique",
        size: 20,
        savedAt: 1_700_000_100_000,
        kind: "image",
        path: "/private/__private_chart.png",
        fileName: "__private_chart.png",
      },
    });
    const exact = await read({ messageId: "9" });
    expect(exact?.details).toMatchObject({
      messages: [{ messageId: "9", body: "An attached chart", mediaRef: "telegram:file/chart-id" }],
      hasMore: false,
    });
    expect(JSON.stringify(exact)).not.toContain("__private_chart");
    expect(exact?.details).not.toHaveProperty("messages.0.sourceMessage");
    expect(exact?.details).not.toHaveProperty("messages.0.resolvedMedia");
  });

  it("keeps topicless reads strict and cannot borrow scope from model arguments", async () => {
    await record(101, { threadId: 0, body: "Group root" });
    await record(102, { body: "Private to this topic" });
    const directTopic = await record(103, { body: "Channel direct-message topic" });
    await cache().record({
      accountId: "default",
      chatId: CHAT,
      msg: directTopic.sourceMessage,
      historyEligible: true,
      providerObservedThread: { scope: "direct-messages", id: TOPIC },
    });
    expect((await read({ messageId: "103" }))?.details).toMatchObject({ messages: [] });
    const root = { ...context().toolContext, currentThreadTs: undefined };
    expect((await read({}, { toolContext: root }))?.details).toMatchObject({
      messages: [{ messageId: "101" }],
    });
    expect((await read({ messageId: "102" }, { toolContext: root }))?.details).toMatchObject({
      messages: [],
    });
    await expect(read({ threadId: TOPIC }, { toolContext: root })).rejects.toThrow(/exact topic/);
    for (const overrides of [
      { accountId: "other" },
      { requesterAccountId: undefined },
      { requesterSenderId: undefined },
      { sessionKey: undefined },
      { toolContext: { ...context().toolContext, currentChannelProvider: "discord" } },
      { toolContext: { ...context().toolContext, currentThreadTs: "78" } },
    ]) {
      const params = {
        messageId: "102",
        to: `${CHAT}:topic:${TOPIC}`,
        sessionKey: SESSION,
        requesterAccountId: "default",
        requesterSenderId: "1",
        toolContext: context().toolContext,
        conversationReadOrigin: "direct-operator",
      };
      await expect(read(params, overrides)).rejects.toThrow();
    }
    await expect(read({ to: "-1002" })).rejects.toThrow(/exact topic/);
    await expect(read({ to: `${CHAT}:direct-topic:${TOPIC}` })).rejects.toThrow(/exact topic/);
    await expect(read({}, { requesterSenderId: "2" })).rejects.toThrow(/current group policy/);
  });

  it.each(["policy", "session", "plugin"] as const)(
    "rechecks %s authority after retained storage awaits",
    async (owner) => {
      await record(10);
      afterStoreRead = () => {
        if (owner === "policy") {
          const denied = structuredClone(cfg);
          denied.channels!.telegram!.groups![CHAT] = { enabled: false };
          setRuntimeConfigSnapshot(denied, denied);
        } else if (owner === "session") {
          sessionCurrent = false;
        } else {
          pluginRecord.enabled = false;
        }
      };
      await expect(read({ conversationReadOrigin: "direct-operator" })).rejects.toThrow(
        /policy changed|authenticated current|authority|revoked/i,
      );
    },
  );

  it("reads older discussion after a session reset watermark and durable cache reopen", async () => {
    await record(9, { body: "The launch codeword is cobalt" });
    await record(100, {
      body: "/status",
      extra: { entities: [{ type: "bot_command", offset: 0, length: 7 }] },
    });
    cfg.commands = { allowFrom: { telegram: ["999"] } };
    const key = resolveAmbientTranscriptWatermarkKey({
      channel: "telegram",
      accountId: "default",
      conversationId: String(CHAT),
      threadId: TOPIC,
    });
    await upsertSessionEntry({
      storePath: resolveStorePath(cfg.session?.store, { agentId: "main" }),
      agentId: "main",
      sessionKey: SESSION,
      entry: {
        sessionId: "after-reset",
        updatedAt: 1_800_000_000_000,
        ambientTranscriptWatermarks: {
          [key]: {
            sessionId: "after-reset",
            messageId: "140",
            timestampMs: 1_800_000_000_000,
            updatedAt: 1_800_000_000_000,
          },
        },
      },
    });
    resetTelegramMessageCacheForTest();
    resetPluginStateStoreForTests();
    expect((await read({ before: "140" }))?.details).toMatchObject({
      messages: [{ messageId: "9", body: "The launch codeword is cobalt" }],
      hasMore: false,
    });
    expect((await read({ messageId: "9" }))?.details).toMatchObject({
      messages: [{ messageId: "9", body: "The launch codeword is cobalt" }],
    });
  });
});
