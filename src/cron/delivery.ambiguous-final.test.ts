import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChannelMessageAdapterFromOutbound } from "../channels/message/outbound-bridge.js";
import type { ChannelOutboundAdapter } from "../channels/plugins/types.public.js";
import {
  installDeliveryQueueTmpDirHooks,
  loadPendingDeliveries,
} from "../infra/outbound/delivery-queue.test-helpers.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { sendCronAnnouncePayloadStrict } from "./delivery.js";
import { makeJob } from "./isolated-agent.test-harness.js";

// Telegram received the request, then the socket closed before its response arrived.
function connectionResetAfterWrite() {
  return Object.assign(new Error("Network request for 'sendMessage' failed!"), {
    cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
  });
}

describe("automation results after an ambiguous transport failure", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  beforeEach(() => vi.stubEnv("OPENCLAW_STATE_DIR", fixtures.tmpDir()));
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  function register(cutOffSends = 1) {
    const visible: string[] = [];
    let attempts = 0;
    const outbound: ChannelOutboundAdapter = {
      deliveryMode: "direct",
      sendText: async ({ text, onPlatformSendDispatch }) => {
        await onPlatformSendDispatch?.();
        if (attempts++ < cutOffSends) {
          throw connectionResetAfterWrite();
        }
        visible.push(text);
        return { channel: "matrix", messageId: `sent-${attempts}` };
      },
    };
    const message = createChannelMessageAdapterFromOutbound({ id: "matrix", outbound });
    const plugin = { ...createOutboundTestPlugin({ id: "matrix", outbound }), message };
    setActivePluginRegistry(createTestRegistry([{ pluginId: "matrix", source: "test", plugin }]));
    return { visible, attempts: () => attempts };
  }

  const job = makeJob({ kind: "agentTurn", message: "Summarize the overnight backups" });
  const send = (completion: boolean) =>
    sendCronAnnouncePayloadStrict({
      deps: {},
      cfg: {},
      agentId: "main",
      jobId: job.id,
      target: { channel: "matrix", to: "!room:example" },
      payload: { text: "Backups finished: 3 of 3 hosts, 41 GB." },
      abortSignal: new AbortController().signal,
      ...(completion
        ? { completion: { job, runStartedAt: 1000, deliveryAttemptFence: null } }
        : {}),
    });

  // Runs the work while skipping its retry backoff and receipt polling.
  async function withoutWaiting<T>(work: Promise<T>): Promise<T> {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const pending = Symbol("pending");
    for (let step = 0; step < 60; step++) {
      if ((await Promise.race([work, Promise.resolve(pending)])) !== pending) {
        break;
      }
      await vi.advanceTimersByTimeAsync(1_000);
    }
    return await work;
  }

  it("resends an automation result once instead of losing it", async () => {
    const channel = register();
    const result = await withoutWaiting(send(true));
    expect(result.status).toBe("sent");
    expect(channel.attempts()).toBe(2);
    expect(channel.visible).toEqual(["Backups finished: 3 of 3 hosts, 41 GB."]);
    expect(await loadPendingDeliveries(fixtures.tmpDir())).toEqual([]);
  });

  it("stops after one resend when that send is cut off too", async () => {
    const channel = register(2);
    await expect(withoutWaiting(send(true))).rejects.toThrow(
      "Network request for 'sendMessage' failed!",
    );
    expect(channel.attempts()).toBe(2);
    expect(channel.visible).toEqual([]);
  });

  it("does not blindly replay a failure alert", async () => {
    const channel = register();
    await expect(send(false)).rejects.toThrow("Network request for 'sendMessage' failed!");
    expect(channel.attempts()).toBe(1);
  });
});
