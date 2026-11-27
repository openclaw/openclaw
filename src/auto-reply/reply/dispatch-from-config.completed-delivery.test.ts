import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { buildEmbeddedRunPayloads } from "../../agents/embedded-agent-runner/run/payloads.js";
import { subscribeEmbeddedAgentSession } from "../../agents/embedded-agent-subscribe.js";
import * as sessionTest from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import * as tts from "../../tts/tts-runtime.test-support.js";
import { withReplyDispatcher } from "../dispatch-dispatcher.js";
import type { ReplyPayload } from "../types.js";
import { buildReplyPayloads } from "./agent-runner-payloads.js";
import { ttsMocks } from "./dispatch-from-config.shared.test-harness.js";
import * as dispatch from "./dispatch-from-config.test-support.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";

sessionTest.registerAgentSessionLoopTestLifecycle();
beforeAll(dispatch.globalBeforeAll0);
afterEach(() => tts.setTtsMachinePrefsPathResolver());
beforeEach(() => {
  dispatch.describe0BeforeEach0();
  dispatch.setNoAbort();
  tts.synthesizeMock.mockClear();
});

const ttsText = "[[tts:text]]Spoken.[[/tts:text]]";
const imageUrl = "https://example.test/image.png";
const voiceUrl = "https://example.test/voice.ogg";
const imageSource = `[[reply_to:12345]]MEDIA:${imageUrl}`;
const voiceSource = `[[audio_as_voice]]MEDIA:${voiceUrl}`;
const audioUrl = "/tmp/completed-delivery-synthetic.ogg";
it.each([
  { name: "visible", source: `Shown. ${ttsText}`, speech: "Spoken.", visible: "Shown." },
  { name: "silence token", source: `${ttsText}NO_REPLY`, speech: "Spoken.", visible: "NO_REPLY" },
  { name: "channel veto", source: ttsText, veto: true },
  { name: "queued speech", source: ttsText, speech: "Spoken.", queued: true },
  { name: "queued target media", source: imageSource, target: "12345", queued: true },
  { name: "queued voice media", source: voiceSource, voice: true, queued: true },
  { name: "speech override denied", source: ttsText, denySpeech: true },
  { name: "plain", source: "Plain reply." },
])("preserves $name", async (scenario) => {
  const { session } = await sessionTest.createTestSession();
  const release = createDeferred();
  const completed = createDeferred();
  let calls = 0;
  let turns = 0;
  let blocks = 0;
  sessionTest.streamMocks.streamSimple.mockImplementation((model) => {
    calls += 1;
    if (scenario.queued && calls === 1) {
      void session.followUp("Then return the final reply.");
    }
    return sessionTest.createAssistantResultStream(
      sessionTest.createAssistant(
        model,
        scenario.queued && calls === 1 ? "Earlier reply." : scenario.source,
      ),
    );
  });
  const subscription = subscribeEmbeddedAgentSession({
    session,
    runId: "admission-proof",
    ...(scenario.queued
      ? {
          blockReplyBreak: "message_end" as const,
          onBlockReplyFlush: () => {},
          onBlockReply: () => (++blocks === 1 ? release.promise : undefined),
        }
      : {}),
  });
  const stopObserve = session.subscribe((event) => {
    if (event.type === "turn_end" && ++turns === 2) {
      completed.resolve();
    }
  });
  const running = session.prompt("Return the synthetic reply.");
  try {
    if (scenario.queued) {
      await awaitGateBeforeSettlement(completed.promise, running, "No second completion");
      release.resolve();
    }
    await running;
    await subscription.waitForPendingEvents();
    const captured = subscription.getCurrentAttemptAssistant();
    const embedded = buildEmbeddedRunPayloads({
      assistantTexts: subscription.assistantTexts,
      answerSegments: subscription.answerSegments,
      lastAssistant: captured,
      currentAssistant: captured ?? null,
      sessionKey: "agent:main:admission",
    });
    const { replyPayloads } = await buildReplyPayloads({
      payloads: embedded,
      blockStreamingEnabled: false,
      blockReplyPipeline: null,
      replyToMode: "off",
      replyToChannel: "telegram",
      currentMessageId: "incoming",
    });
    const cfg = tts.createTtsConfig("completed-delivery-admission-synthetic", {
      auto: "tagged",
      ...(scenario.denySpeech ? { modelOverrides: { allowText: false } } : {}),
    });
    let transformed = false;
    ttsMocks.maybeApplyTtsToPayload.mockImplementation(async (params: unknown) => {
      expect(transformed).toBe(true);
      return tts.maybeApplyTtsToPayloadCore(
        params as Parameters<typeof tts.maybeApplyTtsToPayloadCore>[0],
        async () => audioUrl,
      );
    });
    const deliver = vi.fn(async (_payload: ReplyPayload) => ({
      visibleReplySent: true,
    }));
    const dispatcher = createReplyDispatcher({
      deliver,
      transformReplyPayload: (payload) => {
        transformed = true;
        return scenario.veto ? null : payload;
      },
    });
    await withReplyDispatcher({
      dispatcher,
      run: () =>
        dispatch.dispatchReplyFromConfig({
          ctx: buildTestCtx({
            Body: "Synthetic request.",
            Provider: "telegram",
            Surface: "telegram",
            SessionKey: "agent:main:admission",
          }),
          cfg,
          dispatcher,
          replyResolver: async () => replyPayloads,
        }),
    });
    if (scenario.denySpeech || scenario.veto) {
      expect(tts.synthesizeMock).not.toHaveBeenCalled();
      if (scenario.veto) {
        expect(deliver).not.toHaveBeenCalled();
        expect(transformed).toBe(true);
      }
      return;
    }
    expect(deliver).toHaveBeenCalledTimes(scenario.queued ? 2 : 1);
    const delivered = deliver.mock.calls.at(-1)?.[0];
    expect(tts.synthesizeMock.mock.calls.map(([request]) => request.text)).toEqual(
      scenario.speech ? [scenario.speech] : [],
    );
    // Project text explicitly so an absent property still compares as undefined.
    expect({ ...delivered, text: delivered?.text }).toMatchObject(
      scenario.speech
        ? { text: scenario.visible, mediaUrl: audioUrl, audioAsVoice: true }
        : scenario.voice
          ? { audioAsVoice: true, mediaUrl: voiceUrl }
          : scenario.target
            ? { replyToId: scenario.target, mediaUrl: imageUrl }
            : { text: "Plain reply." },
    );
  } finally {
    release.resolve();
    await running;
    await subscription.waitForPendingEvents();
    subscription.unsubscribe();
    stopObserve();
  }
});
