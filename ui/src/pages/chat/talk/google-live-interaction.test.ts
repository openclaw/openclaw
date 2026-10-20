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
    const onTranscript = vi.fn();
    const transport = await createExtendedThinkingTransport({ onTranscript });
    const ws = await startTransport(transport);

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

    ws.emitMessage(
      encodeJsonFrame({
        toolCall: {
          functionCalls: [{ id: "call-unknown", name: "unknown_tool", args: {} }],
        },
      }),
    );
    await waitForFast(() =>
      expect(ws.messages).toContainEqual({
        toolResponse: {
          functionResponses: [
            {
              id: "call-unknown",
              name: "unknown_tool",
              response: { error: 'Tool "unknown_tool" is not available in browser Talk' },
            },
          ],
        },
      }),
    );
    expect(ws.readyState).toBe(1);

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
      expect(onTranscript).toHaveBeenLastCalledWith({
        role: "assistant",
        text: "The answer is 42.",
        final: true,
      }),
    );
    expect(ws.readyState).toBe(1);
    transport.stop();
  });
});
