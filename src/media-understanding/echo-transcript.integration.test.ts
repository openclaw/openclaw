// Exercise transcript echoes against the real durable SQLite queue with a fake channel adapter.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { MsgContext } from "../auto-reply/templating.js";
import { PlatformMessageNotDispatchedError } from "../infra/outbound/deliver-types.js";
import { deliverOutboundPayloads } from "../infra/outbound/deliver.js";
import { recoverPendingDeliveries } from "../infra/outbound/delivery-queue-recovery.js";
import {
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
  loadPendingDeliveries,
  setQueuedEntryState,
} from "../infra/outbound/delivery-queue.test-helpers.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { sendTranscriptEcho } from "./echo-transcript.js";

describe("Telegram transcript echo durable ownership", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  const sendText = vi.fn();
  let failBeforeDispatch = false;

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_STATE_DIR", fixtures.tmpDir());
    failBeforeDispatch = false;
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
                if (failBeforeDispatch) {
                  failBeforeDispatch = false;
                  throw new PlatformMessageNotDispatchedError(
                    "fixture failure before platform dispatch",
                    { cause: new Error("offline fixture") },
                  );
                }
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
      transcript: "identical synthetic transcript",
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
    } finally {
      finish.resolve({ channel: "telegram", messageId: "first-echo" });
      await first;
    }

    await echo({ OriginatingTo: "telegram:-100123" });
    await echo({ OriginatingTo: "telegram:-100123:direct-topic:7" });
    expect(sendText).toHaveBeenCalledOnce();
  });

  it("leaves a proven-not-sent failure with durable recovery and retains its eventual completion", async () => {
    failBeforeDispatch = true;
    await echo();
    expect(sendText).not.toHaveBeenCalled();
    const pending = await loadPendingDeliveries(fixtures.tmpDir());
    expect(pending).toHaveLength(1);
    const entry = pending[0];
    if (!entry) {
      throw new Error("Expected the retained transcript echo intent");
    }
    expect(pending[0]).toMatchObject({ retryCount: 1 });
    expect(entry.platformSendStartedAt).toBeUndefined();
    await echo();
    expect(sendText).not.toHaveBeenCalled();
    // Advance only the persisted retry schedule; do not grant a second producer owner.
    setQueuedEntryState(fixtures.tmpDir(), entry.id, {
      retryCount: entry.retryCount,
      lastAttemptAt: 1,
      lastError: entry.lastError,
    });
    const recovered = await recoverPendingDeliveries({
      cfg: {},
      deliver: deliverOutboundPayloads,
      log: createRecoveryLog(),
      stateDir: fixtures.tmpDir(),
    });
    expect(recovered).toMatchObject({ recovered: 1, failed: 0 });
    expect(sendText).toHaveBeenCalledOnce();
    await echo();
    expect(sendText).toHaveBeenCalledOnce();
  });

  it("preserves separate source messages, accounts, and chats with identical transcripts", async () => {
    await echo();
    await echo({ MessageSid: "43" });
    await echo({ AccountId: "second-account" });
    await echo({ OriginatingTo: "telegram:-100456:topic:7" });
    expect(sendText).toHaveBeenCalledTimes(4);
  });
});
