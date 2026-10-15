import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { sendDurableMessageBatchCore } from "../../channels/message/send.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import type { OutboundDeliveryIntent } from "./deliver.js";
import { matrixOutboundForQueueTest } from "./deliver.queue-integration.test-support.js";
import { installDeliveryQueueTmpDirHooks } from "./delivery-queue.test-helpers.js";

let deliverOutboundPayloads: typeof import("./deliver.js").deliverOutboundPayloads;

/**
 * The voice supplement that follows an attachment answer is optional audio whose writer
 * fence exists only as in-memory payload metadata. Durable recovery cannot rebuild that
 * fence — the supplement owns no pending-final completion — so a replayed row could send
 * it after the writer was replaced. These run the real delivery path against a real
 * queue state directory: the assertion is that no durable intent is ever created for
 * the supplement, so a restart has nothing of it to replay.
 */
describe("deliverOutboundPayloads: live-only voice supplement", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  let tmpDir: string;
  let intents: ReturnType<typeof vi.fn<(intent: OutboundDeliveryIntent) => void>>;

  beforeAll(async () => {
    ({ deliverOutboundPayloads } = await import("./deliver.js"));
  });

  beforeEach(() => {
    tmpDir = fixtures.tmpDir();
    intents = vi.fn<(intent: OutboundDeliveryIntent) => void>();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({ id: "matrix", outbound: matrixOutboundForQueueTest }),
        },
      ]),
    );
  });

  const liveOnlyVoicePayload = () =>
    setReplyPayloadMetadata(
      {
        mediaUrl: "https://example.com/voice.opus",
        audioAsVoice: true,
        spokenText: "Here is the chart you asked for.",
        ttsSupplement: {
          spokenText: "Here is the chart you asked for.",
          visibleTextAlreadyDelivered: true,
          liveOnly: true,
        },
      },
      {
        sessionWriterDeliveryAuthority: {
          agentId: "main",
          expectedSessionId: "session-writer",
          sessionKey: "agent:main:matrix:!room:example",
          storePath: `${tmpDir}/sessions.sqlite`,
        },
      },
    );

  // The write-ahead intent is what a restart would replay; a completed row is acked
  // away, so the intent — not the leftover row — is the honest signal here.
  const sender = () => vi.fn(async () => ({ messageId: "m1", roomId: "!room:example" }));

  it("creates no durable delivery intent for the supplement", async () => {
    await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:example",
      deliveryQueueStateDir: tmpDir,
      payloads: [liveOnlyVoicePayload()],
      deps: { matrix: sender() },
      onDeliveryIntent: intents,
    });

    expect(intents).not.toHaveBeenCalled();
  });

  it("refuses a batch that mixes the supplement with a durable reply", async () => {
    const send = sender();

    // One batch, one lifetime: persisting the batch would carry the unfenced
    // supplement, and skipping it would strip custody from the ordinary reply.
    await expect(
      deliverOutboundPayloads({
        cfg: {},
        channel: "matrix",
        to: "!room:example",
        deliveryQueueStateDir: tmpDir,
        payloads: [{ text: "Here is the chart you asked for." }, liveOnlyVoicePayload()],
        deps: { matrix: send },
        onDeliveryIntent: intents,
      }),
    ).rejects.toThrow("mixes live-only supplemental audio");

    expect(send).not.toHaveBeenCalled();
    expect(intents).not.toHaveBeenCalled();
  });

  it("stops the supplement before transport when its writer was replaced", async () => {
    const send = sender();

    // The whole production send path, not a stand-in for it: the writer fence is
    // checked where the platform send begins, and the channel adapter — the last
    // thing before I/O — is never reached. The authority points at a store that
    // holds no such session, which is what a replaced writer looks like.
    const result = await sendDurableMessageBatchCore({
      cfg: {},
      channel: "matrix",
      to: "!room:example",
      deliveryQueueStateDir: tmpDir,
      payloads: [liveOnlyVoicePayload()],
      deps: { matrix: send },
    });

    // The union narrows on status, and only the failed arm carries the cause.
    expect(result.status).toBe("failed");
    const failure = result.status === "failed" ? result.error : undefined;
    expect(String(failure)).toContain("Session writer changed before final reply delivery");
    expect(String(failure)).toContain("OPENCLAW_PLATFORM_MESSAGE_NOT_DISPATCHED");
    expect(send).not.toHaveBeenCalled();
  });

  it("creates one for the answer the supplement repeats", async () => {
    await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:example",
      deliveryQueueStateDir: tmpDir,
      payloads: [{ text: "Here is the chart you asked for." }],
      deps: { matrix: sender() },
      onDeliveryIntent: intents,
    });

    // The visible answer keeps durable custody; only the optional audio gives it up.
    expect(intents).toHaveBeenCalled();
  });
});
