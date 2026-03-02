import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";

const { createLineBotMock, tryRegisterPluginHttpRouteMock, unregisterHttpMock } = vi.hoisted(
  () => ({
    createLineBotMock: vi.fn(() => ({
      account: { accountId: "default" },
      handleWebhook: vi.fn(),
    })),
    tryRegisterPluginHttpRouteMock: vi.fn(),
    unregisterHttpMock: vi.fn(),
  }),
);

vi.mock("./bot.js", () => ({
  createLineBot: createLineBotMock,
}));

vi.mock("../auto-reply/chunk.js", () => ({
  chunkMarkdownText: vi.fn(),
}));

vi.mock("../auto-reply/reply/provider-dispatcher.js", () => ({
  dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
}));

vi.mock("../channels/reply-prefix.js", () => ({
  createReplyPrefixOptions: vi.fn(() => ({})),
}));

vi.mock("../globals.js", () => ({
  danger: (value: unknown) => String(value),
  logVerbose: vi.fn(),
}));

vi.mock("../plugins/http-path.js", () => ({
  normalizePluginHttpPath: (_path: string | undefined, fallback: string) => fallback,
}));

vi.mock("../plugins/http-registry.js", () => ({
  tryRegisterPluginHttpRoute: tryRegisterPluginHttpRouteMock,
}));

vi.mock("./webhook-node.js", () => ({
  createLineNodeWebhookHandler: vi.fn(() => vi.fn()),
}));

vi.mock("./auto-reply-delivery.js", () => ({
  deliverLineAutoReply: vi.fn(),
}));

vi.mock("./markdown-to-line.js", () => ({
  processLineMessage: vi.fn(),
}));

vi.mock("./reply-chunks.js", () => ({
  sendLineReplyChunks: vi.fn(),
}));

vi.mock("./send.js", () => ({
  createFlexMessage: vi.fn(),
  createImageMessage: vi.fn(),
  createLocationMessage: vi.fn(),
  createQuickReplyItems: vi.fn(),
  createTextMessageWithQuickReplies: vi.fn(),
  getUserDisplayName: vi.fn(),
  pushMessageLine: vi.fn(),
  pushMessagesLine: vi.fn(),
  pushTextMessageWithQuickReplies: vi.fn(),
  replyMessageLine: vi.fn(),
  showLoadingAnimation: vi.fn(),
}));

vi.mock("./template-messages.js", () => ({
  buildTemplateMessageFromPayload: vi.fn(),
}));

describe("monitorLineProvider lifecycle", () => {
  beforeEach(() => {
    createLineBotMock.mockClear();
    unregisterHttpMock.mockClear();
    tryRegisterPluginHttpRouteMock
      .mockClear()
      .mockReturnValue({ ok: true, unregister: unregisterHttpMock });
  });

  it("waits for abort before resolving", async () => {
    const { monitorLineProvider } = await import("./monitor.js");
    const abort = new AbortController();
    let resolved = false;

    const task = monitorLineProvider({
      channelAccessToken: "token",
      channelSecret: "secret",
      config: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
      abortSignal: abort.signal,
    }).then((monitor) => {
      resolved = true;
      return monitor;
    });

    await vi.waitFor(() => expect(tryRegisterPluginHttpRouteMock).toHaveBeenCalledTimes(1));
    expect(resolved).toBe(false);

    abort.abort();
    await task;
    expect(unregisterHttpMock).toHaveBeenCalledTimes(1);
  });

  it("stops immediately when signal is already aborted", async () => {
    const { monitorLineProvider } = await import("./monitor.js");
    const abort = new AbortController();
    abort.abort();

    await monitorLineProvider({
      channelAccessToken: "token",
      channelSecret: "secret",
      config: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
      abortSignal: abort.signal,
    });

    expect(unregisterHttpMock).toHaveBeenCalledTimes(1);
  });

  it("returns immediately without abort signal and stop is idempotent", async () => {
    const { monitorLineProvider } = await import("./monitor.js");

    const monitor = await monitorLineProvider({
      channelAccessToken: "token",
      channelSecret: "secret",
      config: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
    });

    expect(unregisterHttpMock).not.toHaveBeenCalled();
    monitor.stop();
    monitor.stop();
    expect(unregisterHttpMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed when route registration is rejected", async () => {
    const { monitorLineProvider } = await import("./monitor.js");
    tryRegisterPluginHttpRouteMock.mockReturnValueOnce({ ok: false, unregister: vi.fn() });

    await expect(
      monitorLineProvider({
        channelAccessToken: "token",
        channelSecret: "secret",
        config: {} as OpenClawConfig,
        runtime: {
          log: vi.fn(),
          error: vi.fn(),
          exit: vi.fn(),
        } as RuntimeEnv,
      }),
    ).rejects.toThrow("line: failed to register webhook handler at /line/webhook");
  });
});
