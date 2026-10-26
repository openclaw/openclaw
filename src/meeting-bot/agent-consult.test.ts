import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { RealtimeVoiceBridgeSession } from "../talk/session-runtime.js";

const consultRealtimeVoiceAgent = vi.hoisted(() => vi.fn(async () => ({ text: "done" })));

vi.mock("../talk/agent-consult-runtime.js", () => ({ consultRealtimeVoiceAgent }));

import { createMeetingRealtimeEngineBindings } from "./agent-consult.js";
import { TEST_MEETING_PLATFORM_METADATA } from "./observation-provenance.test-support.js";

const args = { question: "What should I say?" };

function handleToolCall(
  strategy: "agent" | "bidi",
  submitToolResult: RealtimeVoiceBridgeSession["submitToolResult"],
  events: Array<{ type: string; final?: boolean }>,
  agentId: string | undefined,
) {
  return createMeetingRealtimeEngineBindings({
    platform: TEST_MEETING_PLATFORM_METADATA,
    config: { realtime: { agentId, toolPolicy: "safe-read-only" } },
    fullConfig: { agents: { entries: { operator: {} } } },
    runtime: { agent: {} } as never,
    logger: {} as never,
  }).handleToolCall({
    meetingSessionId: "meeting-1",
    transcript: [],
    strategy,
    session: {
      bridge: { supportsToolResultContinuation: false },
      submitToolResult,
    } as unknown as RealtimeVoiceBridgeSession,
    event: {
      itemId: "item-1",
      callId: "call-1",
      name: "openclaw_agent_consult",
      args,
    },
    onTalkEvent: (event) => events.push(event),
  });
}

beforeEach(() => consultRealtimeVoiceAgent.mockClear());

it("emits a final tool event only after the bridge accepts the result", async () => {
  const accepted = createDeferred();
  const submitToolResult = vi.fn(() => accepted.promise);
  const events: Array<{ type: string; final?: boolean }> = [];

  const handled = handleToolCall("agent", submitToolResult, events, "Support");

  expect(submitToolResult).toHaveBeenCalledTimes(1);
  expect(events).toEqual([]);
  accepted.resolve();
  await handled;
  expect(events).toEqual([expect.objectContaining({ type: "tool.error", final: true })]);
});

it.each([
  [undefined, "operator"],
  ["Support", "support"],
])("routes agent %s and does not retry a rejected result", async (configured, expected) => {
  const submitToolResult = vi.fn(async () => {
    throw new Error("result delivery failed");
  });
  const events: Array<{ type: string }> = [];

  await expect(handleToolCall("bidi", submitToolResult, events, configured)).rejects.toThrow(
    "result delivery failed",
  );

  expect(consultRealtimeVoiceAgent).toHaveBeenCalledTimes(1);
  expect(consultRealtimeVoiceAgent).toHaveBeenCalledWith(
    expect.objectContaining({
      agentId: expected,
      sessionKey: `agent:${expected}:subagent:test-meeting:meeting-1`,
      spawnedBy: `agent:${expected}:main`,
    }),
  );
  expect(submitToolResult).toHaveBeenCalledTimes(1);
  expect(events.map((event) => event.type)).toEqual(["tool.progress"]);
});
