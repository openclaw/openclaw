import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { assert, beforeEach, expect, it, vi } from "vitest";
import { buildPayloads } from "../../agents/embedded-agent-runner/run/payloads.test-helpers.js";
import {
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
} from "../../auto-reply/reply-payload.js";
import {
  clearRuntimeConfigSnapshot,
  createMockSpeechProvider,
  createTtsConfig,
  installSpeechProviders,
  maybeApplyTtsToPayloadCore,
  prepareSynthesisMock,
  setTtsMachinePrefsPathResolver,
  synthesizeMock,
  transcodeAudioBufferMock,
} from "../../tts/tts-runtime.test-support.js";
import { maybeApplyTtsToCronPayloads } from "./delivery-dispatch-policy.js";
import { normalizeDirectCronDeliveryPayloads } from "./delivery-payload-normalization.js";
import { resolveCronPayloadOutcome } from "./helpers.js";

// Keep the production TTS policy and provider adapter; only audio persistence
// is replaced so this owner-boundary proof creates no media or channel sends.
vi.mock("../../tts/tts.runtime.js", () => ({
  maybeApplyTtsToPayload: (params: Parameters<typeof maybeApplyTtsToPayloadCore>[0]) =>
    maybeApplyTtsToPayloadCore(params, async () => "/tmp/cron-speech-proof.ogg"),
}));

beforeEach(async ({ onTestFinished }) => {
  const { getLastTtsAttempt, setLastTtsAttempt } = await import("../../tts/tts-payload.js");
  const previousTtsAttempt = getLastTtsAttempt();
  onTestFinished(() => {
    setLastTtsAttempt(previousTtsAttempt);
    setTtsMachinePrefsPathResolver();
    clearRuntimeConfigSnapshot();
    vi.restoreAllMocks();
  });
  for (const mock of [synthesizeMock, prepareSynthesisMock, transcodeAudioBufferMock]) {
    mock.mockClear();
  }
  installSpeechProviders([createMockSpeechProvider()]);
});

it.each(["whatsapp", "telegram", "slack"] as const)(
  "preserves authored speech for %s",
  async (channel) => {
    const visibleText = "Your report is ready.";
    const spokenText = "The report has finished successfully.";
    const payloads = buildPayloads({
      isCronTrigger: true,
      lastAssistant: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: visibleText }],
        openclawDelivery: { tts: { tagged: true, text: spokenText } },
      } as AssistantMessage,
    });
    const prepared = resolveCronPayloadOutcome({
      payloads,
      finalAssistantVisibleText: visibleText,
      preferFinalAssistantVisibleText: channel !== "whatsapp",
    });
    const source = prepared.deliveryPayloads[0]!;
    source.text = "NO_REPLY";
    const metadata = {
      ...getReplyPayloadMetadata(source),
      channelReplyTransformOwner: {},
      sourceReplyTranscriptMirror: { sessionKey: "agent:main:source" },
    };
    setReplyPayloadMetadata(source, metadata);
    const normalized = normalizeDirectCronDeliveryPayloads(prepared);
    assert(normalized.kind === "deliver", "expected deliverable canonical reply");
    expect(normalized.payload).toEqual([{ text: "NO_REPLY" }]);
    expect(getReplyPayloadMetadata(normalized.payload[0]!)).toEqual(metadata);
    expect(source.text).toBe("NO_REPLY");

    const result = await maybeApplyTtsToCronPayloads({
      cfg: createTtsConfig(`openclaw-cron-speech-${randomUUID()}`),
      payloads: normalized.payload,
      delivery: { channel },
      agentId: "main",
      ttsAuto: channel === "telegram" ? "always" : "tagged",
    });

    expect(synthesizeMock.mock.calls[0]?.[0].text).toBe(spokenText);
    expect(result).toMatchObject([
      { text: "NO_REPLY", spokenText, mediaUrl: "/tmp/cron-speech-proof.ogg" },
    ]);
    expect(getReplyPayloadMetadata(payloads[0]!)?.tts?.text).toBe(spokenText);
  },
);
