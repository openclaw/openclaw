import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { RealtimeVoiceBridgeSession } from "../talk/session-runtime.js";

const consultRealtimeVoiceAgent = vi.hoisted(() => vi.fn(async () => ({ text: "done" })));

vi.mock("../talk/agent-consult-runtime.js", () => ({ consultRealtimeVoiceAgent }));

import { createMeetingRealtimeEngineBindings } from "./agent-consult.js";
import { TEST_MEETING_PLATFORM_METADATA } from "./observation-provenance.test-support.js";

const platform = {
  ...TEST_MEETING_PLATFORM_METADATA,
  agentConsult: {
    ...TEST_MEETING_PLATFORM_METADATA.agentConsult,
    surface: "a test meeting",
    extraSystemPrompt: "Answer briefly.",
  },
  session: { idPrefix: "test_meeting", participantIdentity: () => "Test participant" },
};

function createBindings(agentId: string | undefined) {
  return createMeetingRealtimeEngineBindings({
    platform,
    config: {
      realtime: { ...(agentId ? { agentId } : {}), toolPolicy: "safe-read-only" },
    },
    fullConfig: { agents: { entries: { operator: {} } } },
    runtime: { agent: {} } as never,
    logger: {} as never,
  });
}

const consult = {
  meetingSessionId: "meeting-1",
  args: { question: "What should I say?" },
  transcript: [],
};

function handleToolCall(
  strategy: "agent" | "bidi",
  submitToolResult: RealtimeVoiceBridgeSession["submitToolResult"],
  events: Array<{ type: string; final?: boolean }>,
) {
  return createBindings("Support").handleToolCall({
    ...consult,
    strategy,
    session: {
      bridge: { supportsToolResultContinuation: false },
      submitToolResult,
    } as unknown as RealtimeVoiceBridgeSession,
    event: {
      itemId: "item-1",
      callId: "call-1",
      name: "openclaw_agent_consult",
      args: consult.args,
    },
    onTalkEvent: (event) => events.push(event),
  });
}

describe("createMeetingRealtimeEngineBindings", () => {
  beforeEach(() => consultRealtimeVoiceAgent.mockClear());

  it.each([
    [undefined, "operator"],
    ["Support", "support"],
  ])("derives platform metadata and routes agent %s as %s", async (configured, expected) => {
    const bindings = createBindings(configured);
    expect(bindings.platform).toEqual({
      displayName: "Test Meeting",
      logScope: "[test-meeting]",
      sessionIdPrefix: "test-meeting",
    });
    await bindings.consultAgent(consult);

    expect(consultRealtimeVoiceAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: expected,
        messageProvider: "test-meeting",
        lane: "test-meeting",
        surface: "a test meeting",
        sessionKey: `agent:${expected}:subagent:test-meeting:meeting-1`,
        spawnedBy: `agent:${expected}:main`,
      }),
    );
  });

  it("emits a final tool event only after the bridge accepts the result", async () => {
    const accepted = createDeferred();
    const submitToolResult = vi.fn(() => accepted.promise);
    const events: Array<{ type: string; final?: boolean }> = [];

    const handled = handleToolCall("agent", submitToolResult, events);

    expect(submitToolResult).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
    accepted.resolve();
    await handled;
    expect(events).toEqual([expect.objectContaining({ type: "tool.error", final: true })]);
  });

  it("does not retry a rejected result submission as a second tool error", async () => {
    const submitToolResult = vi.fn(async () => {
      throw new Error("result delivery failed");
    });
    const events: Array<{ type: string }> = [];

    await expect(handleToolCall("bidi", submitToolResult, events)).rejects.toThrow(
      "result delivery failed",
    );

    expect(consultRealtimeVoiceAgent).toHaveBeenCalledTimes(1);
    expect(submitToolResult).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.type)).toEqual(["tool.progress"]);
  });
});
