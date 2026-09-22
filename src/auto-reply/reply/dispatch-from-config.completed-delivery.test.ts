import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { buildEmbeddedRunPayloads } from "../../agents/embedded-agent-runner/run/payloads.js";
import { subscribeEmbeddedAgentSession } from "../../agents/embedded-agent-subscribe.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
} from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import {
  createTtsConfig,
  maybeApplyTtsToPayloadCore,
  setTtsMachinePrefsPathResolver,
  synthesizeMock,
} from "../../tts/tts-runtime.test-support.js";
import type { ReplyPayload } from "../types.js";
import { buildReplyPayloads } from "./agent-runner-payloads.js";
import { ttsMocks } from "./dispatch-from-config.shared.test-harness.js";
import {
  describe0BeforeEach0,
  dispatchReplyFromConfig,
  globalBeforeAll0,
  setNoAbort,
} from "./dispatch-from-config.test-harness.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";

registerAgentSessionLoopTestLifecycle();
beforeAll(globalBeforeAll0);
afterEach(() => setTtsMachinePrefsPathResolver());
beforeEach(() => {
  describe0BeforeEach0();
  setNoAbort();
  synthesizeMock.mockClear();
});

describe("completed delivery through runner and dispatcher", () => {
  it.each([
    {
      name: "speech only",
      source: "[[tts:text]]Spoken only.[[/tts:text]]",
      speech: "Spoken only.",
    },
    {
      name: "speech with visible text",
      source: "Shown. [[tts:text]]Spoken only.[[/tts:text]]",
      speech: "Spoken only.",
      visible: "Shown.",
    },
    {
      name: "voice media",
      source: "[[audio_as_voice]]MEDIA:https://example.test/voice.ogg",
      voice: true,
    },
    {
      name: "target media",
      source: "[[reply_to:12345]]MEDIA:https://example.test/image.png",
      target: "12345",
    },
    {
      name: "explicit speech alongside silence",
      source: "[[tts:text]]Speak this.[[/tts:text]]NO_REPLY",
      speech: "Speak this.",
    },
    { name: "channel veto", source: "[[tts:text]]Do not speak.[[/tts:text]]", veto: true },
    {
      name: "queued speech only",
      source: "[[tts:text]]Spoken only.[[/tts:text]]",
      speech: "Spoken only.",
      queued: true,
    },
    {
      name: "queued target media",
      source: "[[reply_to:12345]]MEDIA:https://example.test/image.png",
      target: "12345",
      queued: true,
    },
    {
      name: "queued voice media",
      source: "[[audio_as_voice]]MEDIA:https://example.test/voice.ogg",
      voice: true,
      queued: true,
    },
    {
      name: "speech override denied",
      source: "[[tts:text]]Do not synthesize.[[/tts:text]]",
      denySpeech: true,
    },
    { name: "plain silence", source: "NO_REPLY", silent: true },
    { name: "plain", source: "Plain reply." },
  ])("preserves $name", async (scenario) => {
    const { session } = await createTestSession();
    const release = createDeferred();
    const completed = createDeferred();
    let calls = 0;
    let turns = 0;
    let blocks = 0;
    streamMocks.streamSimple.mockImplementation((model: Model) => {
      calls += 1;
      if (scenario.queued && calls === 1) {
        void session.followUp("Then return the final reply.");
      }
      return createAssistantResultStream(
        createAssistant(model, [
          {
            type: "text",
            text: scenario.queued && calls === 1 ? "Earlier reply." : scenario.source,
          },
        ]),
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
        await Promise.race([
          completed.promise,
          running.then(() => {
            throw new Error("No second completion");
          }),
        ]);
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
      if (scenario.target) {
        expect
          .soft(embedded.at(-1))
          .toMatchObject({ replyToId: scenario.target, replyToTag: true });
      }
      const { replyPayloads } = await buildReplyPayloads({
        payloads: embedded,
        isHeartbeat: false,
        didLogHeartbeatStrip: false,
        blockStreamingEnabled: false,
        blockReplyPipeline: null,
        replyToMode: "off",
        replyToChannel: "telegram",
        currentMessageId: "incoming",
      });
      if (scenario.silent) {
        expect(replyPayloads).toEqual([]);
        return;
      }
      expect(replyPayloads).toHaveLength(scenario.queued ? 2 : 1);
      const cfg = createTtsConfig("completed-delivery-admission-synthetic");
      cfg.tts = {
        ...cfg.tts,
        auto: "tagged",
        ...(scenario.denySpeech ? { modelOverrides: { allowText: false } } : {}),
      };
      let transformed = false;
      ttsMocks.maybeApplyTtsToPayload.mockImplementation(async (params: unknown) => {
        expect(transformed).toBe(true);
        return maybeApplyTtsToPayloadCore(
          params as Parameters<typeof maybeApplyTtsToPayloadCore>[0],
          async () => "/tmp/completed-delivery-synthetic.ogg",
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
      try {
        await dispatchReplyFromConfig({
          ctx: buildTestCtx({
            Body: "Synthetic request.",
            Provider: "telegram",
            Surface: "telegram",
            SessionKey: "agent:main:admission",
          }),
          cfg,
          dispatcher,
          replyResolver: async () => replyPayloads,
        });
      } finally {
        dispatcher.markComplete();
        await dispatcher.waitForIdle();
      }
      if (scenario.denySpeech) {
        expect(synthesizeMock).not.toHaveBeenCalled();
        return;
      }
      if (scenario.veto) {
        expect(synthesizeMock).not.toHaveBeenCalled();
        expect(deliver).not.toHaveBeenCalled();
        expect(transformed).toBe(true);
        return;
      }
      expect(deliver).toHaveBeenCalledTimes(scenario.queued ? 2 : 1);
      const delivered = deliver.mock.calls.at(-1)?.[0];
      if (scenario.speech) {
        expect(synthesizeMock).toHaveBeenCalledTimes(1);
        expect(synthesizeMock.mock.calls[0]?.[0].text).toBe(scenario.speech);
        expect(delivered?.text).toBe(scenario.visible);
        expect(delivered).toMatchObject({
          mediaUrl: "/tmp/completed-delivery-synthetic.ogg",
          audioAsVoice: true,
        });
      } else {
        expect(synthesizeMock).not.toHaveBeenCalled();
        expect(delivered).toMatchObject(
          scenario.voice
            ? { audioAsVoice: true, mediaUrl: "https://example.test/voice.ogg" }
            : scenario.target
              ? { replyToId: scenario.target, mediaUrl: "https://example.test/image.png" }
              : { text: "Plain reply." },
        );
      }
    } finally {
      release.resolve();
      await running;
      await subscription.waitForPendingEvents();
      subscription.unsubscribe();
      stopObserve();
    }
  });
});
