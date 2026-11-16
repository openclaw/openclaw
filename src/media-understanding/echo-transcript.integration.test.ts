// Exercise transcript echoes against the real durable SQLite queue with a fake channel adapter.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { MsgContext } from "../auto-reply/templating.js";
import { installDeliveryQueueTmpDirHooks } from "../infra/outbound/delivery-queue.test-helpers.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { sendTranscriptEcho } from "./echo-transcript.js";

describe("Telegram transcript echo durable ownership", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  const sendText = vi.fn();

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_STATE_DIR", fixtures.tmpDir());
    sendText.mockReset().mockResolvedValue({ channel: "telegram", messageId: "echo-fixture" });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "telegram",
            outbound: {
              deliveryMode: "direct",
              sendText: async (params) => {
                await params.onPlatformSendDispatch?.();
                return await sendText(params);
              },
            },
          }),
        },
      ]),
    );
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
    vi.unstubAllEnvs();
  });

  function echo(overrides: Partial<MsgContext> = {}) {
    return sendTranscriptEcho({
      cfg: {},
      ctx: {
        Provider: "telegram",
        AccountId: "account-fixture",
        OriginatingTo: "telegram:-100123:topic:7",
        MessageThreadId: 7,
        MessageSid: "42",
        ...overrides,
      },
      transcript: "tickets cost $$40, wait for the deal & confirm with $&",
    });
  }

  it("sends once for concurrent processing and a replay after completion", async () => {
    const started = createDeferred();
    const finish = createDeferred<{ channel: "telegram"; messageId: string }>();
    sendText.mockImplementationOnce(async () => {
      started.resolve();
      return await finish.promise;
    });

    const first = echo({ OriginatingTo: "telegram:group:-100123:topic:7" });
    // If delivery fails before reaching the adapter, fail promptly instead of hanging the suite.
    await Promise.race([
      started.promise,
      first.then(() => {
        throw new Error("echo returned before reaching the fake adapter");
      }),
    ]);
    try {
      await echo();
      expect(sendText).toHaveBeenCalledOnce();
      expect(sendText).toHaveBeenCalledWith(
        expect.objectContaining({
          text: '📝 "tickets cost $$40, wait for the deal & confirm with $&"',
        }),
      );
    } finally {
      finish.resolve({ channel: "telegram", messageId: "first-echo" });
      await first;
    }

    await echo({ OriginatingTo: "telegram:-100123" });
    await echo({ OriginatingTo: "telegram:-100123:direct-topic:7" });
    expect(sendText).toHaveBeenCalledOnce();
  });

  it("preserves separate source messages, accounts, and chats with identical transcripts", async () => {
    await echo();
    await echo({ MessageSid: "43" });
    await echo({ AccountId: "second-account" });
    await echo({ OriginatingTo: "telegram:-100456:topic:7" });
    await echo({ OriginatingTo: undefined, From: "telegram:-100789:topic:7" });
    expect(sendText).toHaveBeenCalledTimes(5);
  });

  it.each([{ Provider: "internal-system" }, { OriginatingTo: undefined, From: undefined }])(
    "skips undeliverable transcript destinations: %j",
    async (context) => {
      await echo(context);
      expect(sendText).not.toHaveBeenCalled();
    },
  );

  it("swallows delivery failures", async () => {
    sendText.mockRejectedValueOnce(new Error("delivery timeout"));
    await expect(echo()).resolves.toBeUndefined();
    expect(sendText).toHaveBeenCalledOnce();
  });
});
