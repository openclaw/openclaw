import { describe, expect, it, vi } from "vitest";
import type { RealtimeVoiceAgentConsultRunner } from "../../../talk/provider-types.js";
import { bindTalkRealtimeRelayAgentConsult } from "./agent-consult.js";

describe("relay agent consult lifecycle", () => {
  it("reports native consult lifecycle with one correlated call id", async () => {
    const runPrompt = Object.assign(
      vi.fn<RealtimeVoiceAgentConsultRunner>(async () => ({ text: "done" })),
      {
        adoptCompletionClaims: vi.fn(),
        claimAppend: vi.fn(() => true),
        claimFailureAppend: vi.fn(() => true),
      },
    );
    const emit = vi.fn();
    const runAgentConsult = bindTalkRealtimeRelayAgentConsult(
      runPrompt,
      () => true,
      async () => {},
      { relaySessionId: "relay-1", harness: { ensureTurn: () => "turn-1" }, emit },
    );

    await expect(runAgentConsult({ prompt: "Do the work" })).resolves.toEqual({ text: "done" });

    const talkEvents = emit.mock.calls.map(([, talkEvent]) => talkEvent);
    expect(talkEvents.map((event) => event.type)).toEqual(["tool.call", "tool.result"]);
    expect(talkEvents[0].callId).toMatch(/^native-consult-/);
    expect(talkEvents[1]).toMatchObject({
      callId: talkEvents[0].callId,
      turnId: "turn-1",
      final: true,
      payload: { status: "completed" },
    });
  });
});
