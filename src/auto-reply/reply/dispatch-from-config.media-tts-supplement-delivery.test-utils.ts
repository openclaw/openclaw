// Imported by a dispatch-from-config entrypoint to keep its mocked suite in one Vitest module graph.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearRuntimeConfigSnapshot } from "../../config/config.js";
import {
  getReplyPayloadMetadata,
  getReplyPayloadTtsSupplement,
  setReplyPayloadMetadata,
} from "../reply-payload.js";
import type { MsgContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import {
  createDispatcher,
  emptyConfig,
  mocks,
  sessionStoreMocks,
  ttsMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import {
  dispatchReplyFromConfig,
  setNoAbort,
  globalBeforeAll0,
  describe0BeforeEach0,
} from "./dispatch-from-config.test-support.js";
import { deliverFinalWithMedia } from "./dispatch-from-config.tts-guard.test-support.js";
import { normalizeReplyPayload } from "./normalize-reply.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";

/**
 * The half of the voice-supplement suite about delivery: writer authority, what the
 * voice repeats, and the silences a failed or invisible delivery must keep. Its
 * sibling covers which media is spoken at all; both are separate modules so no file
 * grows past the repository's line cap.
 */
beforeAll(globalBeforeAll0);

describe("dispatchReplyFromConfig media voice supplement delivery fences", () => {
  beforeEach(() => {
    clearRuntimeConfigSnapshot();
    describe0BeforeEach0();
  });
  afterEach(clearRuntimeConfigSnapshot);

  // ── The supplement is fenced by the same writer authority as its answer ────
  // A settled final can carry `sessionWriterDeliveryAuthority`, and an absent authority
  // reads as "authorized" at every check. Rebuilding the supplement without it would let
  // audio derived from a replaced writer reach the channel after the answer was accepted.
  // Rejection at the queue boundary is covered by the deliver.live-only-supplement
  // integration test; here we only pin that the dispatcher inherits the authority.
  const writerAuthorityPayload = (payload: ReplyPayload): ReplyPayload =>
    setReplyPayloadMetadata(payload, {
      sessionWriterDeliveryAuthority: {
        expectedLifecycleRevision: "revision-a",
        expectedSessionId: "s1",
        expectedWriterRunId: "run-settled",
        sessionKey: "agent:main:telegram:direct:123",
        storePath: "/tmp/mock-sessions.json",
      },
    });

  const withCurrentWriter = () => {
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      lifecycleRevision: "revision-a",
      activeWriterRunId: "run-settled",
      updatedAt: 0,
    };
  };

  async function deliverPictureWithWriterAuthority(): Promise<ReplyPayload[]> {
    setNoAbort();
    withCurrentWriter();
    ttsMocks.state.synthesizeFinalAudio = true;
    const delivered: ReplyPayload[] = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload);
      },
    });

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "telegram",
        Surface: "telegram",
        SessionKey: "agent:main:telegram:direct:123",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyOptions: { runId: "run-settled" },
      replyResolver: async () =>
        writerAuthorityPayload({
          text: "Here is the chart you asked for.",
          mediaUrl: "/tmp/chart.png",
        }),
    });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
    return delivered;
  }

  it("speaks a picture answer whose session writer still holds the turn", async () => {
    const delivered = await deliverPictureWithWriterAuthority();

    expect(delivered.map((payload) => payload.mediaUrl)).toEqual([
      "/tmp/chart.png",
      "https://example.com/tts-synth.opus",
    ]);
  });

  it("carries the writer authority onto the voice supplement", async () => {
    const delivered = await deliverPictureWithWriterAuthority();

    // The supplement must inherit the authority of the answer it repeats: the queue
    // boundary reads it from the delivered payload, and without it the audio would read
    // as authorized after a writer replacement (an absent authority authorizes at every
    // check). Rejection at that boundary is covered by the integration test.
    const supplement = expectDefined(
      delivered.find((payload) => payload.mediaUrl === "https://example.com/tts-synth.opus"),
      "voice supplement",
    );
    expect(getReplyPayloadMetadata(supplement)?.sessionWriterDeliveryAuthority).toMatchObject({
      expectedSessionId: "s1",
      expectedWriterRunId: "run-settled",
    });
  });

  it("speaks the text delivery prepared, not the raw reply", async () => {
    setNoAbort();
    ttsMocks.state.synthesizeFinalAudio = true;
    // The host strips the heartbeat acknowledgement before dispatch. The recording
    // cannot be normalized afterwards, so the supplement must synthesize the prepared
    // text rather than the reply the model originally produced.
    const prepared = expectDefined(
      normalizeReplyPayload({
        text: "Here is the chart you asked for. HEARTBEAT_OK",
        mediaUrl: "/tmp/chart.png",
      }),
      "prepared final",
    );
    expect(prepared.text).toBe("Here is the chart you asked for.");

    const delivered = await deliverFinalWithMedia(prepared);
    expect(delivered).toHaveLength(2);
    expect(delivered[0]?.payload.text).toBe("Here is the chart you asked for.");
    expect(
      getReplyPayloadTtsSupplement(expectDefined(delivered[1]?.payload, "voice supplement"))
        ?.spokenText,
    ).not.toContain("HEARTBEAT_OK");
  });

  it("speaks a picture answer whose text the block already delivered", async () => {
    setNoAbort();
    ttsMocks.state.synthesizeFinalAudio = true;
    const delivered: Array<{ kind: string; payload: ReplyPayload }> = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload, info) => {
        delivered.push({ kind: info.kind, payload });
      },
    });
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload> => {
      await opts?.onBlockReply?.({ text: "the whole answer" });
      return { text: "the whole answer", mediaUrl: "/tmp/chart.png" };
    };

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({ Provider: "qa-channel", Surface: "qa-channel" }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    // The block carried the visible answer and was delivered, so there is a message to
    // speak to even though the final itself was deduped against it.
    expect(
      delivered.some(({ payload }) => payload.mediaUrl === "https://example.com/tts-synth.opus"),
    ).toBe(true);
  });

  it("stays silent when the channel vetoed the block the voice would follow", async () => {
    setNoAbort();
    ttsMocks.state.synthesizeFinalAudio = true;
    const delivered: ReplyPayload[] = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload, info) => {
        delivered.push(payload);
        if (info.kind === "block") {
          return {
            visibleReplySent: false,
            suppression: { reason: "channel_transform" as const },
          };
        }
        return undefined;
      },
    });
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload> => {
      await opts?.onBlockReply?.({
        text: "the answer the channel handled itself",
        mediaUrl: "/tmp/chart.png",
      });
      return {
        text: "the answer the channel handled itself",
        mediaUrl: "/tmp/chart.png",
      };
    };

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({ Provider: "qa-channel", Surface: "qa-channel" }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    // The channel took the answer over and showed nothing of ours; a voice message would
    // arrive alone, following a message the recipient never saw.
    expect(
      delivered.some((payload) => payload.mediaUrl === "https://example.com/tts-synth.opus"),
    ).toBe(false);
  });

  it("stays silent when the visible answer failed to route", async () => {
    setNoAbort();
    ttsMocks.state.synthesizeFinalAudio = true;
    mocks.routeReply.mockResolvedValue({
      ok: false,
      delivered: false,
      error: "transport down",
    });
    const dispatcher = createDispatcher();

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "slack",
        Surface: "slack",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:999",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: async () => ({
        text: "Here is the chart you asked for.",
        mediaUrl: "/tmp/chart.png",
      }),
    });

    // The picture never reached the recipient, so its voice must not arrive on its own.
    const spoken = mocks.routeReply.mock.calls.filter(
      ([call]) => call.payload?.mediaUrl === "https://example.com/tts-synth.opus",
    );
    expect(spoken).toHaveLength(0);
  });

  it.each([
    {
      label: "cancelled in beforeDeliver",
      dispatcherOptions: {
        beforeDeliver: (payload: ReplyPayload) => (payload.mediaUrl ? null : payload),
      },
    },
    {
      label: "suppressed as a channel transform",
      dispatcherOptions: {
        deliver: async () => ({
          visibleReplySent: false,
          suppression: { reason: "channel_transform" as const },
        }),
      },
    },
  ])("stays silent when the queued answer ends up $label", async ({ dispatcherOptions }) => {
    setNoAbort();
    ttsMocks.state.synthesizeFinalAudio = true;
    const delivered: ReplyPayload[] = [];
    const dispatcher = createReplyDispatcher({
      ...dispatcherOptions,
      deliver: async (payload: ReplyPayload, info: { kind: string }) => {
        delivered.push(payload);
        return await (
          dispatcherOptions as {
            deliver?: (p: ReplyPayload, i: { kind: string }) => Promise<unknown>;
          }
        ).deliver?.(payload, info);
      },
    });

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({ Provider: "qa-channel", Surface: "qa-channel" }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: async () => ({
        text: "Here is the chart you asked for.",
        mediaUrl: "/tmp/chart.png",
      }),
    });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    // Admission is not visibility: the answer was accepted into the queue and then
    // lost before transport, so its voice must not arrive on its own.
    expect(
      delivered.some((payload) => payload.mediaUrl === "https://example.com/tts-synth.opus"),
    ).toBe(false);
  });

  it("stays silent when the answer was delivered but not visibly", async () => {
    setNoAbort();
    ttsMocks.state.synthesizeFinalAudio = true;
    const delivered: ReplyPayload[] = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload);
        return { visibleReplySent: false };
      },
    });

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({ Provider: "qa-channel", Surface: "qa-channel" }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: async () => ({
        text: "Here is the chart you asked for.",
        mediaUrl: "/tmp/chart.png",
      }),
    });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    // The transport accepted the payload without showing it. Speaking to a message the
    // recipient cannot see is the same failure as speaking to one that never went out.
    expect(
      delivered.some((payload) => payload.mediaUrl === "https://example.com/tts-synth.opus"),
    ).toBe(false);
  });

  it("marks the voice supplement live-only, so no replay outlives its writer", async () => {
    setNoAbort();
    ttsMocks.state.synthesizeFinalAudio = true;
    mocks.routeReply.mockClear();
    const dispatcher = createReplyDispatcher({ deliver: async () => {} });

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:999",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: async () => ({
        text: "Here is the chart you asked for.",
        mediaUrl: "https://example.com/chart.png",
      }),
    });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    const routed = mocks.routeReply.mock.calls.map(
      ([value]) => (value as { payload: ReplyPayload }).payload,
    );
    const answer = routed.find((payload) => payload.mediaUrl === "https://example.com/chart.png");
    const voice = routed.find((payload) => payload.audioAsVoice === true);
    // The answer keeps durable custody; the audio that repeats it asks for none,
    // because recovery cannot rebuild the in-memory writer fence it carries. The
    // flag rides on the payload, so channel-local delivery honors it too — see
    // `src/channels/message/send.test.ts` for the queue boundary itself.
    expect(answer?.ttsSupplement?.liveOnly).toBeUndefined();
    expect(voice?.ttsSupplement?.liveOnly).toBe(true);
  });

  it("speaks a picture answer as a separate voice message", async () => {
    setNoAbort();
    ttsMocks.state.synthesizeFinalAudio = true;
    const delivered: Array<{ kind: string; payload: ReplyPayload }> = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload, info) => {
        delivered.push({ kind: info.kind, payload });
      },
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({ Provider: "qa-channel", Surface: "qa-channel" }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: async () => ({
        text: "Here is the chart you asked for.",
        mediaUrl: "https://example.com/chart.png",
      }),
    });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual([
      {
        kind: "final",
        payload: expect.objectContaining({
          text: "Here is the chart you asked for.",
          mediaUrl: "https://example.com/chart.png",
        }),
      },
      {
        kind: "final",
        payload: expect.objectContaining({
          text: undefined,
          mediaUrl: "https://example.com/tts-synth.opus",
          audioAsVoice: true,
        }),
      },
    ]);
    expect(
      getReplyPayloadTtsSupplement(
        expectDefined(delivered[1]?.payload, "voice supplement payload"),
      ),
    ).toEqual({
      spokenText: "Here is the chart you asked for.",
      visibleTextAlreadyDelivered: true,
      liveOnly: true,
    });
    expect(result.counts.final).toBe(2);
  });

  it("keeps a picture answer silent when synthesis produces no audio", async () => {
    setNoAbort();
    ttsMocks.state.synthesizeFinalAudio = false;
    const delivered: Array<{ kind: string; payload: ReplyPayload }> = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload, info) => {
        delivered.push({ kind: info.kind, payload });
      },
    });

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({ Provider: "qa-channel", Surface: "qa-channel" }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: async () => ({
        text: "Here is the chart you asked for.",
        mediaUrl: "https://example.com/chart.png",
      }),
    });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual([
      {
        kind: "final",
        payload: expect.objectContaining({
          text: "Here is the chart you asked for.",
          mediaUrl: "https://example.com/chart.png",
        }),
      },
    ]);
  });
});
