import { describe, expect, it, vi } from "vitest";
import { waitForFast } from "../../../test-helpers/wait-for.ts";
import {
  createClient,
  createSession,
  encodeJsonFrame,
  installGoogleLiveTestFixture,
  startTransport,
} from "./google-live.test-support.ts";
import { GoogleLiveRealtimeTalkTransport } from "./google-live.ts";
import { prepareRealtimeTalkTestInput } from "./input.test-support.ts";
import type { RealtimeTalkTransportContext } from "./shared.ts";

const GOOGLE_LIVE_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained";

async function createExtendedThinkingTransport(
  callbacks: RealtimeTalkTransportContext["callbacks"],
) {
  return new GoogleLiveRealtimeTalkTransport(
    {
      ...createSession(GOOGLE_LIVE_URL),
      model: "gemini-3.8-live-extended-thinking",
    },
    {
      input: await prepareRealtimeTalkTestInput(),
      callbacks,
      client: createClient(),
      sessionKey: "main",
    },
  );
}

describe("Google Live Extended Thinking interaction lifecycle", () => {
  installGoogleLiveTestFixture();

  it("stays active across a filler utterance and tool call", async () => {
    const onTalkEvent = vi.fn();
    const onTranscript = vi.fn();
    const transport = await createExtendedThinkingTransport({ onTalkEvent, onTranscript });
    const ws = await startTransport(transport);
    onTalkEvent.mockClear();

    ws.emitMessage(
      encodeJsonFrame({
        serverContent: {
          outputTranscription: { text: "Checking now." },
          turnComplete: true,
          interactionStatus: "IN_PROGRESS",
        },
      }),
    );
    await waitForFast(() =>
      expect(onTranscript).toHaveBeenLastCalledWith({
        role: "assistant",
        text: "Checking now.",
        final: true,
      }),
    );
    expect(onTalkEvent.mock.calls.map(([event]) => event.type)).not.toContain("turn.ended");

    ws.emitMessage(
      encodeJsonFrame({
        toolCall: {
          functionCalls: [{ id: "call-unknown", name: "unknown_tool", args: {} }],
        },
      }),
    );
    await waitForFast(() =>
      expect(onTalkEvent.mock.calls.map(([event]) => event.type)).toContain("tool.error"),
    );
    expect(onTalkEvent.mock.calls.map(([event]) => event.type)).not.toContain("turn.ended");

    ws.emitMessage(
      encodeJsonFrame({
        serverContent: {
          outputTranscription: { text: "The answer is 42." },
          turnComplete: true,
          interactionStatus: "IDLE",
        },
      }),
    );
    await waitForFast(() =>
      expect(onTalkEvent.mock.calls.map(([event]) => event.type)).toContain("turn.ended"),
    );
    expect(onTalkEvent.mock.calls.filter(([event]) => event.type === "turn.ended")).toHaveLength(1);
  });

  it("cancels an interrupted turn before interaction IDLE", async () => {
    const onTalkEvent = vi.fn();
    const transport = await createExtendedThinkingTransport({ onTalkEvent });
    const ws = await startTransport(transport);
    onTalkEvent.mockClear();

    ws.emitMessage(
      encodeJsonFrame({
        serverContent: {
          interrupted: true,
          turnComplete: true,
          interactionStatus: "IN_PROGRESS",
        },
      }),
    );

    await waitForFast(() =>
      expect(onTalkEvent.mock.calls.map(([event]) => event.type)).toContain("turn.cancelled"),
    );
    expect(onTalkEvent.mock.calls.map(([event]) => event.type)).not.toContain("turn.ended");
  });
});
