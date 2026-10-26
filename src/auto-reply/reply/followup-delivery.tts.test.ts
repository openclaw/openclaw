import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TtsAutoMode } from "../../config/types.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import type { SpeechProviderPlugin } from "../../plugins/types.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  getReplyPayloadMetadata,
  isReplyPayloadTerminalContent,
  setReplyPayloadMetadata,
} from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { deliverFollowupDecision, resolveFollowupDeliveryDecision } from "./followup-delivery.js";
import { createDefaults, createTurn } from "./followup-delivery.test-helpers.js";
import { collectRuntimeMetadata } from "./queue/delivery-context.js";
import { createMockReplyOperation } from "./test-helpers.js";

const STALLED_TURN_NOTICE_TEXT =
  "⚠️ This turn was interrupted because it stopped making progress. Please try again.";

const outbound = vi.hoisted(() => vi.fn());

// mock-isolation: resolve synthetic routes without loading model or authentication plans.
vi.mock("../../agents/runtime-plan/build.js", () => ({
  buildAgentRuntimeDeliveryPlan: () => ({ resolveFollowupRoute: () => undefined }),
}));
// mock-isolation: capture outbound payloads without loading delivery queues or contacting channels.
vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloadsInternal: (...args: unknown[]) => outbound(...args),
}));

const speech = "The queued assistant answer should include automatic speech.";
const audio = Buffer.from("deterministic synthetic speech fixture");
const providerId = "queued-tts-fixture";
let state: OpenClawTestState;
const synthesize = vi.fn<SpeechProviderPlugin["synthesize"]>(async () => ({
  audioBuffer: audio,
  fileExtension: ".ogg",
  outputFormat: "ogg",
  voiceCompatible: true,
}));

beforeEach(async () => {
  state = await createOpenClawTestState({ prefix: "openclaw-queued-tts-", layout: "home" });
  vi.stubEnv("OPENCLAW_TTS_PREFS", state.path("tts-prefs.json"));
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Network forbidden in queued TTS proof");
    }),
  );
  synthesize.mockClear();
  outbound.mockReset().mockResolvedValue([{ channel: "discord", messageId: "synthetic-delivery" }]);
  const registry = createTestRegistry([
    {
      pluginId: "discord",
      source: "test",
      plugin: createChannelTestPluginBase({
        id: "discord",
        capabilities: {
          chatTypes: ["direct"],
          media: true,
          tts: { voice: { synthesisTarget: "voice-note" } },
        },
      }),
    },
  ]);
  registry.channels.push({
    pluginId: "matrix",
    source: "test",
    plugin: createChannelTestPluginBase({
      id: "matrix",
      capabilities: {
        chatTypes: ["direct"],
        media: true,
        tts: { voice: { synthesisTarget: "voice-note" } },
      },
    }),
  });
  registry.speechProviders.push({
    pluginId: providerId,
    source: "test",
    provider: {
      id: providerId,
      label: "Queued TTS fixture",
      isConfigured: () => true,
      synthesize,
    },
  });
  setActivePluginRegistry(registry);
});
afterEach(async () => {
  setActivePluginRegistry(createTestRegistry());
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await state.cleanup();
});

async function send(
  turn = createTurn(),
  payload: ReplyPayload = { text: speech },
  originFails = false,
) {
  turn.config = { tts: { auto: "always", provider: providerId }, ...turn.config };
  if (originFails) {
    outbound.mockRejectedValueOnce(new Error("synthetic transport failure"));
  }
  const fallback = vi.fn(async (_payload: ReplyPayload) => {});
  const result = await deliverFollowupDecision({
    turn,
    decision: { kind: "deliver", payloads: [payload] },
    defaults: createDefaults(fallback),
    runId: "queued-tts-run",
    runFollowup: vi.fn(async () => {}),
  });
  return { result, fallback };
}

describe("queued automatic speech at the delivery boundary", () => {
  it("synthesizes eligible queued text and routes the persisted audio with its metadata", async () => {
    const turn = createTurn();
    turn.queued.originatingAccountId = "selected-account";
    turn.queued.originatingThreadId = "selected-thread";
    const payload = setReplyPayloadMetadata(
      { text: speech, replyToId: "parent" },
      { assistantTranscriptOwned: true },
    );
    await send(turn, payload);

    expect(synthesize).toHaveBeenCalledOnce();
    expect(synthesize.mock.calls[0]?.[0]).toMatchObject({ text: speech, target: "voice-note" });
    const sent = outbound.mock.calls[0]?.[0];
    expect(sent).toMatchObject({
      channel: "discord",
      to: "channel:C1",
      accountId: "selected-account",
      threadId: "selected-thread",
    });
    const delivered = sent.payloads[0];
    expect(delivered).toMatchObject({
      text: speech,
      replyToId: "parent",
      audioAsVoice: true,
      spokenText: speech,
      ttsSupplement: { spokenText: speech },
    });
    expect(getReplyPayloadMetadata(delivered)?.assistantTranscriptOwned).toBe(true);
    expect(await fs.readFile(delivered.mediaUrl)).toEqual(audio);
  });
});

it.each<{
  mode: TtsAutoMode;
  inbound?: boolean;
  sessionAuto?: TtsAutoMode;
  tagged?: boolean;
  audio: boolean;
}>([
  { mode: "off", audio: false },
  { mode: "off", sessionAuto: "always", audio: true },
  { mode: "always", sessionAuto: "off", audio: false },
  { mode: "inbound", inbound: false, audio: false },
  { mode: "inbound", inbound: true, audio: true },
  { mode: "tagged", audio: false },
  { mode: "tagged", tagged: true, audio: true },
])(
  "honors $mode speech policy (inbound=$inbound, session=$sessionAuto, tagged=$tagged)",
  async ({ mode, inbound, sessionAuto, tagged, audio: expectedAudio }) => {
    const turn = createTurn({ config: { tts: { auto: mode, provider: providerId } } });
    turn.queued.currentInboundAudio = inbound;
    turn.session.current = () => ({ sessionId: "session", updatedAt: 1, ttsAuto: sessionAuto });
    const payload = tagged
      ? setReplyPayloadMetadata({ text: speech }, { tts: { tagged: true, text: speech } })
      : { text: speech };
    await send(turn, payload);
    expect(synthesize).toHaveBeenCalledTimes(expectedAudio ? 1 : 0);
    const sent = outbound.mock.calls[0]?.[0].payloads[0];
    expect(sent.text).toBe(speech);
    expect(Boolean(sent.mediaUrl)).toBe(expectedAudio);
  },
);

it.each<ReplyPayload>([
  { text: speech, mediaUrl: "https://example.com/existing.ogg", audioAsVoice: true },
  { text: speech, mediaUrls: ["https://example.com/image.png"] },
  { text: speech, isReasoning: true },
  { text: speech, isCommentary: true },
  { text: speech, isStatusNotice: true },
])("does not synthesize existing media or excluded content: %j", async (payload) => {
  await send(createTurn(), payload);
  expect(synthesize).not.toHaveBeenCalled();
});

it("keeps text when the speech provider fails", async () => {
  synthesize.mockRejectedValueOnce(new Error("synthetic synthesis failure"));
  await send();
  expect(synthesize).toHaveBeenCalledOnce();
  expect(outbound.mock.calls[0]?.[0].payloads).toEqual([{ text: speech }]);
});

it("reuses prepared audio when origin routing falls back to the source dispatcher", async () => {
  const { fallback } = await send(createTurn(), { text: speech }, true);
  expect(synthesize).toHaveBeenCalledOnce();
  const routed = outbound.mock.calls[0]?.[0].payloads[0];
  expect(fallback).toHaveBeenCalledExactlyOnceWith(routed);
  expect(await fs.readFile(routed.mediaUrl)).toEqual(audio);
});

it("uses the selected destination account and agent settings instead of the ingress surface", async () => {
  const turn = createTurn({
    config: {
      tts: { auto: "off", provider: providerId },
      agents: {
        entries: {
          agent: {
            tts: { auto: "always", providers: { [providerId]: { speakerVoice: "agent-voice" } } },
          },
        },
      },
      channels: {
        matrix: {
          tts: { auto: "off" },
          accounts: {
            selected: {
              tts: {
                auto: "always",
                providers: { [providerId]: { speakerVoice: "destination-voice" } },
              },
            },
          },
        },
      },
    },
  });
  turn.queued.run.messageProvider = "slack";
  turn.queued.originatingChannel = "matrix";
  turn.queued.originatingAccountId = "selected";
  await send(turn);
  expect(synthesize).toHaveBeenCalledOnce();
  expect(synthesize.mock.calls[0]?.[0].providerConfig).toMatchObject({
    speakerVoice: "destination-voice",
  });
  expect(outbound.mock.calls[0]?.[0]).toMatchObject({ channel: "matrix", accountId: "selected" });
});

it("uses local preferences and lets the queued session override them", async () => {
  await fs.writeFile(state.path("tts-prefs.json"), JSON.stringify({ tts: { auto: "off" } }));
  await send();
  expect(synthesize).not.toHaveBeenCalled();
  const turn = createTurn();
  turn.session.current = () => ({ sessionId: "session", updatedAt: 1, ttsAuto: "always" });
  await send(turn);
  expect(synthesize).toHaveBeenCalledOnce();
  expect(outbound.mock.calls[1]?.[0].payloads[0].mediaUrl).toBeTruthy();
});

it("preserves inbound speech eligibility for a collected follow-up", async () => {
  const first = createTurn().queued;
  first.currentInboundAudio = true;
  const turn = createTurn({ config: { tts: { auto: "inbound", provider: providerId } } });
  Object.assign(turn.queued, collectRuntimeMetadata([first, createTurn().queued]));
  await send(turn);
  expect(synthesize).toHaveBeenCalledOnce();
  expect(outbound.mock.calls[0]?.[0].payloads[0].mediaUrl).toBeTruthy();
});

it("does not synthesize a reply suppressed by every collected source", async () => {
  const turn = createTurn();
  turn.queued.deliveryCorrelations = [{ begin() {}, shouldSuppressReply: () => true }];
  await send(turn);
  expect(synthesize).not.toHaveBeenCalled();
  expect(outbound).not.toHaveBeenCalled();
});

it("returns prepared audio to the source-owned terminal batch without sending it early", async () => {
  const turn = createTurn();
  turn.queued.originatingChannel = "webchat";
  turn.queued.originatingTo = undefined;
  const deliver = vi.fn(async () => {});
  turn.queued.queuedFollowupReplyDisposition = { kind: "deliver", deliver };
  const { result } = await send(turn);
  expect(synthesize).toHaveBeenCalledOnce();
  expect(result).toMatchObject({
    kind: "completed",
    payloads: [{ text: speech, spokenText: speech, mediaUrl: expect.any(String) }],
  });
  expect(deliver).not.toHaveBeenCalled();
  expect(outbound).not.toHaveBeenCalled();
});

it("does not route audio after the queued operation is aborted during synthesis", async () => {
  const controller = new AbortController();
  const { replyOperation } = createMockReplyOperation({ abortSignal: controller.signal });
  synthesize.mockImplementationOnce(async () => {
    controller.abort(new Error("synthetic queued cancellation"));
    return {
      audioBuffer: audio,
      fileExtension: ".ogg",
      outputFormat: "ogg",
      voiceCompatible: true,
    };
  });
  await expect(send(createTurn({ operation: replyOperation }))).rejects.toThrow(
    "synthetic queued cancellation",
  );
  expect(outbound).not.toHaveBeenCalled();
});

it.each(["origin", "source-owned"] as const)(
  "keeps the aborted stalled-recovery terminal notice under %s delivery custody",
  async (route) => {
    const { replyOperation } = createMockReplyOperation({
      abortSignal: AbortSignal.abort(new Error("synthetic stalled recovery")),
    });
    const turn = createTurn({
      config: { tts: { auto: "always", provider: providerId } },
      operation: {
        ...replyOperation,
        result: { kind: "failed", code: "run_stalled" },
        staleExpiryReason: "stuck_recovery",
      },
    });
    turn.queued.stalledTurnRecovery = true;
    turn.queued.run.sourceReplyDeliveryMode = "message_tool_only";
    const sourceDelivery = vi.fn(async () => {});
    if (route === "source-owned") {
      turn.queued.originatingChannel = "webchat";
      turn.queued.originatingTo = undefined;
      turn.queued.queuedFollowupReplyDisposition = { kind: "deliver", deliver: sourceDelivery };
    }
    const decision = await resolveFollowupDeliveryDecision({
      turn,
      execution: { runId: turn.runId, outcome: { kind: "aborted", reason: "user" } },
    });
    expect(decision).toMatchObject({
      kind: "deliver",
      payloads: [{ text: STALLED_TURN_NOTICE_TEXT, isError: true }],
    });
    if (decision.kind !== "deliver") {
      throw new Error("Expected the stalled recovery owner to produce its last-resort notice");
    }
    const runFollowup = vi.fn(async () => {});
    const observed = vi.fn();
    const result = await deliverFollowupDecision({
      decision,
      turn,
      defaults: createDefaults(vi.fn(async () => {})),
      runId: turn.runId,
      runFollowup,
      onObservedReplyDelivery: observed,
    });

    expect(synthesize).not.toHaveBeenCalled();
    expect(result).toEqual({
      kind: "completed",
      payloads: route === "source-owned" ? decision.payloads : [],
    });
    const delivered =
      route === "source-owned" && result.kind === "completed"
        ? result.payloads[0]
        : outbound.mock.calls[0]?.[0].payloads[0];
    expect(delivered).toEqual({ text: STALLED_TURN_NOTICE_TEXT, isError: true });
    expect(isReplyPayloadTerminalContent(delivered)).toBe(true);
    expect(getReplyPayloadMetadata(delivered)?.deliverDespiteSourceReplySuppression).toBe(true);
    expect(outbound).toHaveBeenCalledTimes(route === "origin" ? 1 : 0);
    expect(observed).toHaveBeenCalledTimes(route === "origin" ? 1 : 0);
    expect(sourceDelivery).not.toHaveBeenCalled();
    expect(runFollowup).not.toHaveBeenCalled();
  },
);
