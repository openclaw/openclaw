import path from "node:path";
import type { Bot } from "grammy";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { STATE_DIR } from "../config/paths.js";

const createTelegramDraftStream = vi.hoisted(() => vi.fn());
const dispatchReplyWithBufferedBlockDispatcher = vi.hoisted(() => vi.fn());
const deliverReplies = vi.hoisted(() => vi.fn());
const editMessageTelegram = vi.hoisted(() => vi.fn());
const loadSessionStore = vi.hoisted(() => vi.fn());
const resolveStorePath = vi.hoisted(() => vi.fn(() => "/tmp/sessions.json"));

vi.mock("./draft-stream.js", () => ({
  createTelegramDraftStream,
}));

vi.mock("../auto-reply/reply/provider-dispatcher.js", () => ({
  dispatchReplyWithBufferedBlockDispatcher,
}));

vi.mock("./bot/delivery.js", () => ({
  deliverReplies,
}));

vi.mock("./send.js", () => ({
  editMessageTelegram,
}));

vi.mock("../config/sessions.js", async () => ({
  loadSessionStore,
  resolveStorePath,
}));

vi.mock("./sticker-cache.js", () => ({
  cacheSticker: vi.fn(),
  describeStickerImage: vi.fn(),
}));

import { dispatchTelegramMessage } from "./bot-message-dispatch.js";

describe("dispatchTelegramMessage draft streaming", () => {
  type TelegramMessageContext = Parameters<typeof dispatchTelegramMessage>[0]["context"];

  beforeEach(() => {
    createTelegramDraftStream.mockReset();
    dispatchReplyWithBufferedBlockDispatcher.mockReset();
    deliverReplies.mockReset();
    editMessageTelegram.mockReset();
    loadSessionStore.mockReset();
    resolveStorePath.mockReset();
    resolveStorePath.mockReturnValue("/tmp/sessions.json");
    loadSessionStore.mockReturnValue({});
  });

  function createDraftStream(messageId?: number) {
    return {
      update: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
      messageId: vi.fn().mockReturnValue(messageId),
      clear: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      forceNewMessage: vi.fn(),
    };
  }

  function setupDraftStreams(params?: { answerMessageId?: number; reasoningMessageId?: number }) {
    const answerDraftStream = createDraftStream(params?.answerMessageId);
    const reasoningDraftStream = createDraftStream(params?.reasoningMessageId);
    createTelegramDraftStream
      .mockImplementationOnce(() => answerDraftStream)
      .mockImplementationOnce(() => reasoningDraftStream);
    return { answerDraftStream, reasoningDraftStream };
  }

  function createContext(overrides?: Partial<TelegramMessageContext>): TelegramMessageContext {
    const base = {
      ctxPayload: {},
      primaryCtx: { message: { chat: { id: 123, type: "private" } } },
      msg: {
        chat: { id: 123, type: "private" },
        message_id: 456,
        message_thread_id: 777,
      },
      chatId: 123,
      isGroup: false,
      resolvedThreadId: undefined,
      replyThreadId: 777,
      threadSpec: { id: 777, scope: "dm" },
      historyKey: undefined,
      historyLimit: 0,
      groupHistories: new Map(),
      route: { agentId: "default", accountId: "default" },
      skillFilter: undefined,
      sendTyping: vi.fn(),
      sendRecordVoice: vi.fn(),
      ackReactionPromise: null,
      reactionApi: null,
      removeAckAfterReply: false,
    } as unknown as TelegramMessageContext;

    return {
      ...base,
      ...overrides,
      // Merge nested fields when overrides provide partial objects.
      primaryCtx: {
        ...(base.primaryCtx as object),
        ...(overrides?.primaryCtx ? (overrides.primaryCtx as object) : null),
      } as TelegramMessageContext["primaryCtx"],
      msg: {
        ...(base.msg as object),
        ...(overrides?.msg ? (overrides.msg as object) : null),
      } as TelegramMessageContext["msg"],
      route: {
        ...(base.route as object),
        ...(overrides?.route ? (overrides.route as object) : null),
      } as TelegramMessageContext["route"],
    };
  }

  function createBot(): Bot {
    return { api: { sendMessage: vi.fn(), editMessageText: vi.fn() } } as unknown as Bot;
  }

  function createRuntime(): Parameters<typeof dispatchTelegramMessage>[0]["runtime"] {
    return {
      log: vi.fn(),
      error: vi.fn(),
      exit: () => {
        throw new Error("exit");
      },
    };
  }

  async function dispatchWithContext(params: {
    context: TelegramMessageContext;
    telegramCfg?: Parameters<typeof dispatchTelegramMessage>[0]["telegramCfg"];
    streamMode?: Parameters<typeof dispatchTelegramMessage>[0]["streamMode"];
  }) {
    await dispatchTelegramMessage({
      context: params.context,
      bot: createBot(),
      cfg: {},
      runtime: createRuntime(),
      replyToMode: "first",
      streamMode: params.streamMode ?? "partial",
      textLimit: 4096,
      telegramCfg: params.telegramCfg ?? {},
      opts: { token: "token" },
    });
  }

  it("streams drafts in private threads and forwards thread id", async () => {
    const draftStream = createDraftStream();
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Hello" });
        await dispatcherOptions.deliver({ text: "Hello" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    const context = createContext({
      route: {
        agentId: "work",
      } as unknown as TelegramMessageContext["route"],
    });
    await dispatchWithContext({ context });

    expect(createTelegramDraftStream).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 123,
        thread: { id: 777, scope: "dm" },
        minInitialChars: 1,
      }),
    );
    expect(draftStream.update).toHaveBeenCalledWith("Hello");
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        thread: { id: 777, scope: "dm" },
        mediaLocalRoots: expect.arrayContaining([path.join(STATE_DIR, "workspace-work")]),
      }),
    );
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        replyOptions: expect.objectContaining({
          disableBlockStreaming: true,
        }),
      }),
    );
    expect(editMessageTelegram).not.toHaveBeenCalled();
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
  });

  it("keeps a higher initial debounce threshold in block stream mode", async () => {
    const draftStream = createDraftStream();
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Hello" });
        await dispatcherOptions.deliver({ text: "Hello" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext(), streamMode: "block" });

    expect(createTelegramDraftStream).toHaveBeenCalledWith(
      expect.objectContaining({
        minInitialChars: 30,
      }),
    );
  });

  it("keeps block streaming enabled when account config enables it", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Hello" }, { kind: "final" });
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext(),
      telegramCfg: { blockStreaming: true },
    });

    expect(createTelegramDraftStream).not.toHaveBeenCalled();
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        replyOptions: expect.objectContaining({
          disableBlockStreaming: false,
          onPartialReply: undefined,
        }),
      }),
    );
  });

  it("keeps block streaming enabled when session reasoning level is on", async () => {
    loadSessionStore.mockReturnValue({
      s1: { reasoningLevel: "on" },
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Reasoning:\n_step_" }, { kind: "block" });
      await dispatcherOptions.deliver({ text: "Hello" }, { kind: "final" });
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: { SessionKey: "s1" } as unknown as TelegramMessageContext["ctxPayload"],
      }),
    });

    expect(createTelegramDraftStream).not.toHaveBeenCalled();
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        replyOptions: expect.objectContaining({
          disableBlockStreaming: false,
        }),
      }),
    );
    expect(loadSessionStore).toHaveBeenCalledWith("/tmp/sessions.json", { skipCache: true });
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: "Reasoning:\n_step_" })],
      }),
    );
  });

  it("streams reasoning draft updates even when answer stream mode is off", async () => {
    loadSessionStore.mockReturnValue({
      s1: { reasoningLevel: "stream" },
    });
    const reasoningDraftStream = createDraftStream(111);
    createTelegramDraftStream.mockImplementationOnce(() => reasoningDraftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onReasoningStream?.({ text: "Reasoning:\n_step_" });
        await dispatcherOptions.deliver({ text: "Hello" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: { SessionKey: "s1" } as unknown as TelegramMessageContext["ctxPayload"],
      }),
      streamMode: "off",
    });

    expect(createTelegramDraftStream).toHaveBeenCalledTimes(1);
    expect(reasoningDraftStream.update).toHaveBeenCalledWith("Reasoning:\n_step_");
    expect(loadSessionStore).toHaveBeenCalledWith("/tmp/sessions.json", { skipCache: true });
  });

  it("finalizes text-only replies by editing the preview message in place", async () => {
    const draftStream = createDraftStream(999);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Hel" });
        await dispatcherOptions.deliver({ text: "Hello final" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "999" });

    await dispatchWithContext({ context: createContext() });

    expect(editMessageTelegram).toHaveBeenCalledWith(123, 999, "Hello final", expect.any(Object));
    expect(deliverReplies).not.toHaveBeenCalled();
    expect(draftStream.clear).not.toHaveBeenCalled();
    expect(draftStream.stop).toHaveBeenCalled();
  });

  it("edits the preview message created during stop() final flush", async () => {
    let messageId: number | undefined;
    const draftStream = {
      update: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
      messageId: vi.fn().mockImplementation(() => messageId),
      clear: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockImplementation(async () => {
        messageId = 777;
      }),
      forceNewMessage: vi.fn(),
    };
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Short final" }, { kind: "final" });
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "777" });

    await dispatchWithContext({ context: createContext() });

    expect(editMessageTelegram).toHaveBeenCalledWith(123, 777, "Short final", expect.any(Object));
    expect(deliverReplies).not.toHaveBeenCalled();
    expect(draftStream.stop).toHaveBeenCalled();
  });

  it("does not overwrite finalized preview when additional final payloads are sent", async () => {
    const draftStream = createDraftStream(999);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Primary result" }, { kind: "final" });
      await dispatcherOptions.deliver(
        { text: "⚠️ Recovered tool error details" },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "999" });

    await dispatchWithContext({ context: createContext() });

    expect(editMessageTelegram).toHaveBeenCalledTimes(1);
    expect(editMessageTelegram).toHaveBeenCalledWith(
      123,
      999,
      "Primary result",
      expect.any(Object),
    );
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: "⚠️ Recovered tool error details" })],
      }),
    );
    expect(draftStream.clear).not.toHaveBeenCalled();
    expect(draftStream.stop).toHaveBeenCalled();
  });

  it("falls back to normal delivery when preview final is too long to edit", async () => {
    const draftStream = createDraftStream(999);
    createTelegramDraftStream.mockReturnValue(draftStream);
    const longText = "x".repeat(5000);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: longText }, { kind: "final" });
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "999" });

    await dispatchWithContext({ context: createContext() });

    expect(editMessageTelegram).not.toHaveBeenCalled();
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: longText })],
      }),
    );
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
    expect(draftStream.stop).toHaveBeenCalled();
  });

  it("disables block streaming when streamMode is off", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Hello" }, { kind: "final" });
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "off",
    });

    expect(createTelegramDraftStream).not.toHaveBeenCalled();
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        replyOptions: expect.objectContaining({
          disableBlockStreaming: true,
        }),
      }),
    );
  });

  it("disables block streaming when streamMode is off even if blockStreaming config is true", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Hello" }, { kind: "final" });
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "off",
      telegramCfg: { blockStreaming: true },
    });

    expect(createTelegramDraftStream).not.toHaveBeenCalled();
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        replyOptions: expect.objectContaining({
          disableBlockStreaming: true,
        }),
      }),
    );
  });

  it("forces new message when new assistant message starts after previous output", async () => {
    const draftStream = createDraftStream(999);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        // First assistant message: partial text
        await replyOptions?.onPartialReply?.({ text: "First response" });
        // New assistant message starts (e.g., after tool call)
        await replyOptions?.onAssistantMessageStart?.();
        // Second assistant message: new text
        await replyOptions?.onPartialReply?.({ text: "After tool call" });
        await dispatcherOptions.deliver({ text: "After tool call" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext(), streamMode: "block" });

    // Should force new message when assistant message starts after previous output
    expect(draftStream.forceNewMessage).toHaveBeenCalled();
  });

  it("does not force new message in partial mode when assistant message restarts", async () => {
    const draftStream = createDraftStream(999);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "First response" });
        await replyOptions?.onAssistantMessageStart?.();
        await replyOptions?.onPartialReply?.({ text: "After tool call" });
        await dispatcherOptions.deliver({ text: "After tool call" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    expect(draftStream.forceNewMessage).not.toHaveBeenCalled();
  });

  it("does not force new message on first assistant message start", async () => {
    const draftStream = createDraftStream(999);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        // First assistant message starts (no previous output)
        await replyOptions?.onAssistantMessageStart?.();
        // Partial updates
        await replyOptions?.onPartialReply?.({ text: "Hello" });
        await replyOptions?.onPartialReply?.({ text: "Hello world" });
        await dispatcherOptions.deliver({ text: "Hello world" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext(), streamMode: "block" });

    // First message start shouldn't trigger forceNewMessage (no previous output)
    expect(draftStream.forceNewMessage).not.toHaveBeenCalled();
  });

  it.each(["block", "partial"] as const)(
    "splits reasoning lane only when a later reasoning block starts (%s mode)",
    async (streamMode) => {
      const { reasoningDraftStream } = setupDraftStreams({
        answerMessageId: 999,
        reasoningMessageId: 111,
      });
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
        async ({ dispatcherOptions, replyOptions }) => {
          await replyOptions?.onReasoningStream?.({ text: "Reasoning:\n_first block_" });
          await replyOptions?.onReasoningEnd?.();
          expect(reasoningDraftStream.forceNewMessage).not.toHaveBeenCalled();
          await replyOptions?.onPartialReply?.({ text: "checking files..." });
          await replyOptions?.onReasoningStream?.({ text: "Reasoning:\n_second block_" });
          await dispatcherOptions.deliver({ text: "Done" }, { kind: "final" });
          return { queuedFinal: true };
        },
      );
      deliverReplies.mockResolvedValue({ delivered: true });
      editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "999" });

      await dispatchWithContext({ context: createContext(), streamMode });

      expect(reasoningDraftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["block", "partial"] as const)(
    "does not split reasoning lane on reasoning end without a later reasoning block (%s mode)",
    async (streamMode) => {
      const { reasoningDraftStream } = setupDraftStreams({
        answerMessageId: 999,
        reasoningMessageId: 111,
      });
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
        async ({ dispatcherOptions, replyOptions }) => {
          await replyOptions?.onReasoningStream?.({ text: "Reasoning:\n_first block_" });
          await replyOptions?.onReasoningEnd?.();
          await replyOptions?.onPartialReply?.({ text: "Here's the answer" });
          await dispatcherOptions.deliver({ text: "Here's the answer" }, { kind: "final" });
          return { queuedFinal: true };
        },
      );
      deliverReplies.mockResolvedValue({ delivered: true });

      await dispatchWithContext({ context: createContext(), streamMode });

      expect(reasoningDraftStream.forceNewMessage).not.toHaveBeenCalled();
    },
  );

  it("does not finalize preview with reasoning payloads before answer payloads", async () => {
    setupDraftStreams({ answerMessageId: 999 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Hi, I did what you asked and..." });
        await dispatcherOptions.deliver({ text: "Reasoning:\n_step one_" }, { kind: "final" });
        await dispatcherOptions.deliver(
          { text: "Hi, I did what you asked and..." },
          { kind: "final" },
        );
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "999" });

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    // Keep reasoning as its own message.
    expect(deliverReplies).toHaveBeenCalledTimes(1);
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: "Reasoning:\n_step one_" })],
      }),
    );
    // Finalize preview with the actual answer instead of overwriting with reasoning.
    expect(editMessageTelegram).toHaveBeenCalledTimes(1);
    expect(editMessageTelegram).toHaveBeenCalledWith(
      123,
      999,
      "Hi, I did what you asked and...",
      expect.any(Object),
    );
  });

  it("keeps reasoning and answer streaming in separate preview lanes", async () => {
    const { answerDraftStream, reasoningDraftStream } = setupDraftStreams({
      answerMessageId: 999,
      reasoningMessageId: 111,
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onReasoningStream?.({ text: "Reasoning:\n_Working on it..._" });
        await replyOptions?.onPartialReply?.({ text: "Checking the directory..." });
        await dispatcherOptions.deliver({ text: "Checking the directory..." }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "999" });

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    expect(reasoningDraftStream.update).toHaveBeenCalledWith("Reasoning:\n_Working on it..._");
    expect(answerDraftStream.update).toHaveBeenCalledWith("Checking the directory...");
    expect(answerDraftStream.forceNewMessage).not.toHaveBeenCalled();
    expect(reasoningDraftStream.forceNewMessage).not.toHaveBeenCalled();
  });

  it("does not edit reasoning preview bubble with final answer when no assistant partial arrived yet", async () => {
    setupDraftStreams({ reasoningMessageId: 999 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onReasoningStream?.({ text: "Reasoning:\n_Working on it..._" });
        await dispatcherOptions.deliver({ text: "Here's what I found." }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "999" });

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    expect(editMessageTelegram).not.toHaveBeenCalled();
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: "Here's what I found." })],
      }),
    );
  });

  it.each(["partial", "block"] as const)(
    "does not duplicate reasoning final after reasoning end (%s mode)",
    async (streamMode) => {
      let reasoningMessageId: number | undefined = 111;
      const reasoningDraftStream = {
        update: vi.fn(),
        flush: vi.fn().mockResolvedValue(undefined),
        messageId: vi.fn().mockImplementation(() => reasoningMessageId),
        clear: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        forceNewMessage: vi.fn().mockImplementation(() => {
          reasoningMessageId = undefined;
        }),
      };
      const answerDraftStream = createDraftStream(999);
      createTelegramDraftStream
        .mockImplementationOnce(() => answerDraftStream)
        .mockImplementationOnce(() => reasoningDraftStream);
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
        async ({ dispatcherOptions, replyOptions }) => {
          await replyOptions?.onReasoningStream?.({ text: "Reasoning:\n_step one_" });
          await replyOptions?.onReasoningEnd?.();
          await dispatcherOptions.deliver(
            { text: "Reasoning:\n_step one expanded_" },
            { kind: "final" },
          );
          return { queuedFinal: true };
        },
      );
      deliverReplies.mockResolvedValue({ delivered: true });
      editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "111" });

      await dispatchWithContext({ context: createContext(), streamMode });

      expect(reasoningDraftStream.forceNewMessage).not.toHaveBeenCalled();
      expect(editMessageTelegram).toHaveBeenCalledWith(
        123,
        111,
        "Reasoning:\n_step one expanded_",
        expect.any(Object),
      );
      expect(deliverReplies).not.toHaveBeenCalled();
    },
  );

  it("updates reasoning preview for reasoning block payloads instead of sending duplicates", async () => {
    setupDraftStreams({ answerMessageId: 999, reasoningMessageId: 111 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onReasoningStream?.({
          text: "Reasoning:\nIf I count r in strawberry, I see positions 3, 8, and",
        });
        await replyOptions?.onReasoningEnd?.();
        await replyOptions?.onPartialReply?.({ text: "3" });
        await dispatcherOptions.deliver({ text: "3" }, { kind: "final" });
        await dispatcherOptions.deliver(
          {
            text: "Reasoning:\nIf I count r in strawberry, I see positions 3, 8, and 9. So the total is 3.",
          },
          { kind: "block" },
        );
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "999" });

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    expect(editMessageTelegram).toHaveBeenNthCalledWith(1, 123, 999, "3", expect.any(Object));
    expect(editMessageTelegram).toHaveBeenNthCalledWith(
      2,
      123,
      111,
      "Reasoning:\nIf I count r in strawberry, I see positions 3, 8, and 9. So the total is 3.",
      expect.any(Object),
    );
    expect(deliverReplies).not.toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [
          expect.objectContaining({
            text: expect.stringContaining("Reasoning:\nIf I count r in strawberry"),
          }),
        ],
      }),
    );
  });

  it("routes think-tag partials to reasoning lane and keeps answer lane clean", async () => {
    const { answerDraftStream, reasoningDraftStream } = setupDraftStreams({
      answerMessageId: 999,
      reasoningMessageId: 111,
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({
          text: "<think>Counting letters in strawberry</think>3",
        });
        await dispatcherOptions.deliver({ text: "3" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "999" });

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    expect(reasoningDraftStream.update).toHaveBeenCalledWith(
      "Reasoning:\n_Counting letters in strawberry_",
    );
    expect(answerDraftStream.update).toHaveBeenCalledWith("3");
    expect(
      answerDraftStream.update.mock.calls.some((call) => String(call[0] ?? "").includes("<think>")),
    ).toBe(false);
    expect(editMessageTelegram).toHaveBeenCalledWith(123, 999, "3", expect.any(Object));
  });

  it("routes unmatched think partials to reasoning lane without leaking answer lane", async () => {
    const { answerDraftStream, reasoningDraftStream } = setupDraftStreams({
      answerMessageId: 999,
      reasoningMessageId: 111,
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({
          text: "<think>Counting letters in strawberry",
        });
        await dispatcherOptions.deliver(
          { text: "There are 3 r's in strawberry." },
          { kind: "final" },
        );
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "999" });

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    expect(reasoningDraftStream.update).toHaveBeenCalledWith(
      "Reasoning:\n_Counting letters in strawberry_",
    );
    expect(
      answerDraftStream.update.mock.calls.some((call) => String(call[0] ?? "").includes("<")),
    ).toBe(false);
    expect(editMessageTelegram).toHaveBeenCalledWith(
      123,
      999,
      "There are 3 r's in strawberry.",
      expect.any(Object),
    );
  });

  it("keeps reasoning preview message when reasoning is streamed but final is answer-only", async () => {
    const { reasoningDraftStream } = setupDraftStreams({
      answerMessageId: 999,
      reasoningMessageId: 111,
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({
          text: "<think>Word: strawberry. r appears at 3, 8, 9.</think>",
        });
        await dispatcherOptions.deliver(
          { text: "There are 3 r's in strawberry." },
          { kind: "final" },
        );
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "999" });

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    expect(reasoningDraftStream.update).toHaveBeenCalledWith(
      "Reasoning:\n_Word: strawberry. r appears at 3, 8, 9._",
    );
    expect(reasoningDraftStream.clear).not.toHaveBeenCalled();
    expect(editMessageTelegram).toHaveBeenCalledWith(
      123,
      999,
      "There are 3 r's in strawberry.",
      expect.any(Object),
    );
  });

  it("splits think-tag final payload into reasoning and answer lanes", async () => {
    setupDraftStreams({
      answerMessageId: 999,
      reasoningMessageId: 111,
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        {
          text: "<think>Word: strawberry. r appears at 3, 8, 9.</think>There are 3 r's in strawberry.",
        },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "999" });

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    expect(editMessageTelegram).toHaveBeenNthCalledWith(
      1,
      123,
      111,
      "Reasoning:\n_Word: strawberry. r appears at 3, 8, 9._",
      expect.any(Object),
    );
    expect(editMessageTelegram).toHaveBeenNthCalledWith(
      2,
      123,
      999,
      "There are 3 r's in strawberry.",
      expect.any(Object),
    );
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("edits stop-created preview when final text is shorter than buffered draft", async () => {
    let answerMessageId: number | undefined;
    const answerDraftStream = {
      update: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
      messageId: vi.fn().mockImplementation(() => answerMessageId),
      clear: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockImplementation(async () => {
        answerMessageId = 999;
      }),
      forceNewMessage: vi.fn(),
    };
    const reasoningDraftStream = createDraftStream();
    createTelegramDraftStream
      .mockImplementationOnce(() => answerDraftStream)
      .mockImplementationOnce(() => reasoningDraftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({
          text: "Let me check that file and confirm details for you.",
        });
        await dispatcherOptions.deliver({ text: "Let me check that file." }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "999" });

    await dispatchWithContext({ context: createContext(), streamMode: "block" });

    expect(editMessageTelegram).toHaveBeenCalledWith(
      123,
      999,
      "Let me check that file.",
      expect.any(Object),
    );
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("does not edit preview message when final payload is an error", async () => {
    const draftStream = createDraftStream(999);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        // Partial text output
        await replyOptions?.onPartialReply?.({ text: "Let me check that file" });
        // Error payload should not edit the preview message
        await dispatcherOptions.deliver(
          { text: "⚠️ 🛠️ Exec: cat /nonexistent failed: No such file", isError: true },
          { kind: "final" },
        );
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext(), streamMode: "block" });

    // Should NOT edit preview message (which would overwrite the partial text)
    expect(editMessageTelegram).not.toHaveBeenCalled();
    // Should deliver via normal path as a new message
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: expect.stringContaining("⚠️") })],
      }),
    );
  });

  it("clears preview for error-only finals", async () => {
    const draftStream = createDraftStream(999);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "tool failed", isError: true }, { kind: "final" });
      await dispatcherOptions.deliver({ text: "another error", isError: true }, { kind: "final" });
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext() });

    // Error payloads skip preview finalization — preview must be cleaned up
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
  });

  it("clears preview after media final delivery", async () => {
    const draftStream = createDraftStream(999);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ mediaUrl: "file:///tmp/a.png" }, { kind: "final" });
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext() });

    expect(draftStream.clear).toHaveBeenCalledTimes(1);
  });

  it("clears stale preview when response is NO_REPLY", async () => {
    const draftStream = createDraftStream(999);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({
      queuedFinal: false,
    });

    await dispatchWithContext({ context: createContext() });

    // Preview contains stale partial text — must be cleaned up
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
  });

  it("falls back when all finals are skipped and clears preview", async () => {
    const draftStream = createDraftStream(999);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      dispatcherOptions.onSkip?.({ text: "" }, { reason: "no_reply", kind: "final" });
      return { queuedFinal: false };
    });
    deliverReplies.mockResolvedValueOnce({ delivered: true });

    await dispatchWithContext({ context: createContext() });

    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [
          expect.objectContaining({
            text: expect.stringContaining("No response"),
          }),
        ],
      }),
    );
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
  });

  it("sends fallback and clears preview when deliver throws (dispatcher swallows error)", async () => {
    const draftStream = createDraftStream();
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      try {
        await dispatcherOptions.deliver({ text: "Hello" }, { kind: "final" });
      } catch (err) {
        dispatcherOptions.onError(err, { kind: "final" });
      }
      return { queuedFinal: false };
    });
    deliverReplies
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ delivered: true });

    await expect(dispatchWithContext({ context: createContext() })).resolves.toBeUndefined();
    // Fallback should be sent because failedDeliveries > 0
    expect(deliverReplies).toHaveBeenCalledTimes(2);
    expect(deliverReplies).toHaveBeenLastCalledWith(
      expect.objectContaining({
        replies: [
          expect.objectContaining({
            text: expect.stringContaining("No response"),
          }),
        ],
      }),
    );
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
  });

  it("sends fallback in off mode when deliver throws", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      try {
        await dispatcherOptions.deliver({ text: "Hello" }, { kind: "final" });
      } catch (err) {
        dispatcherOptions.onError(err, { kind: "final" });
      }
      return { queuedFinal: false };
    });
    deliverReplies
      .mockRejectedValueOnce(new Error("403 bot blocked"))
      .mockResolvedValueOnce({ delivered: true });

    await dispatchWithContext({ context: createContext(), streamMode: "off" });

    expect(createTelegramDraftStream).not.toHaveBeenCalled();
    expect(deliverReplies).toHaveBeenCalledTimes(2);
    expect(deliverReplies).toHaveBeenLastCalledWith(
      expect.objectContaining({
        replies: [
          expect.objectContaining({
            text: expect.stringContaining("No response"),
          }),
        ],
      }),
    );
  });

  it("handles error block + response final — error delivered, response finalizes preview", async () => {
    const draftStream = createDraftStream(999);
    createTelegramDraftStream.mockReturnValue(draftStream);
    editMessageTelegram.mockResolvedValue({ ok: true });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        replyOptions?.onPartialReply?.({ text: "Processing..." });
        await dispatcherOptions.deliver(
          { text: "⚠️ exec failed", isError: true },
          { kind: "block" },
        );
        await dispatcherOptions.deliver(
          { text: "The command timed out. Here's what I found..." },
          { kind: "final" },
        );
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext() });

    // Block error went through deliverReplies
    expect(deliverReplies).toHaveBeenCalledTimes(1);
    // Final was finalized via preview edit
    expect(editMessageTelegram).toHaveBeenCalledWith(
      123,
      999,
      "The command timed out. Here's what I found...",
      expect.any(Object),
    );
    expect(draftStream.clear).not.toHaveBeenCalled();
  });

  it("cleans up preview even when fallback delivery throws (double failure)", async () => {
    const draftStream = createDraftStream();
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      try {
        await dispatcherOptions.deliver({ text: "Hello" }, { kind: "final" });
      } catch (err) {
        dispatcherOptions.onError(err, { kind: "final" });
      }
      return { queuedFinal: false };
    });
    // No preview message id → deliver goes through deliverReplies directly
    // Primary delivery fails
    deliverReplies
      .mockRejectedValueOnce(new Error("network down"))
      // Fallback also fails
      .mockRejectedValueOnce(new Error("still down"));

    // Fallback throws, but cleanup still runs via try/finally.
    await dispatchWithContext({ context: createContext() }).catch(() => {});

    // Verify fallback was attempted and preview still cleaned up
    expect(deliverReplies).toHaveBeenCalledTimes(2);
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
  });

  it("clears preview when dispatcher throws before fallback phase", async () => {
    const draftStream = createDraftStream(999);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockRejectedValue(new Error("dispatcher exploded"));

    await expect(dispatchWithContext({ context: createContext() })).rejects.toThrow(
      "dispatcher exploded",
    );

    expect(draftStream.stop).toHaveBeenCalledTimes(1);
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("supports concurrent dispatches with independent previews", async () => {
    const draftA = createDraftStream(11);
    const draftB = createDraftStream(22);
    createTelegramDraftStream.mockReturnValueOnce(draftA).mockReturnValueOnce(draftB);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "partial" });
        await dispatcherOptions.deliver({ mediaUrl: "file:///tmp/a.png" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await Promise.all([
      dispatchWithContext({
        context: createContext({
          chatId: 1,
          msg: { chat: { id: 1, type: "private" }, message_id: 1 } as never,
        }),
      }),
      dispatchWithContext({
        context: createContext({
          chatId: 2,
          msg: { chat: { id: 2, type: "private" }, message_id: 2 } as never,
        }),
      }),
    ]);

    expect(draftA.clear).toHaveBeenCalledTimes(1);
    expect(draftB.clear).toHaveBeenCalledTimes(1);
  });
});
