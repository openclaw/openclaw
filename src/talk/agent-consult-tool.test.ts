// Agent consult tool tests cover tool payload validation for consult requests.
import { describe, expect, it } from "vitest";
import {
  buildRealtimeVoiceAgentConsultProgressResponse,
  buildRealtimeVoiceAgentConsultWorkingResponse,
  buildRealtimeVoiceAgentConsultChatMessage,
  buildRealtimeVoiceAgentConsultPrompt,
  collectRealtimeVoiceAgentConsultVisibleText,
  parseRealtimeVoiceAgentConsultArgs,
  REALTIME_VOICE_AGENT_CONSULT_TOOL,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  resolveRealtimeVoiceAgentConsultToolPolicy,
  resolveRealtimeVoiceAgentConsultTools,
  resolveRealtimeVoiceAgentConsultToolsAllow,
} from "./agent-consult-tool.js";

describe("realtime voice agent consult tool", () => {
  it("normalizes shared tool arguments for browser chat forwarding", () => {
    expect(
      buildRealtimeVoiceAgentConsultChatMessage({
        question: "  What changed? ",
        context: "  PR #123 ",
        responseStyle: " concise ",
      }),
    ).toBe("What changed?\n\nContext:\nPR #123\n\nSpoken style:\nconcise");
  });

  it("requires a non-empty question", () => {
    expect(() => parseRealtimeVoiceAgentConsultArgs({ context: "missing" })).toThrow(
      "question required",
    );
  });

  it("accepts provider question aliases from realtime tool calls", () => {
    expect(parseRealtimeVoiceAgentConsultArgs({ prompt: "  Check the repo. " })).toStrictEqual({
      context: undefined,
      question: "Check the repo.",
      responseStyle: undefined,
      workingAction: undefined,
      workingMessage: undefined,
    });
    expect(
      parseRealtimeVoiceAgentConsultArgs({ query: "  Send a Discord message. " }),
    ).toStrictEqual({
      context: undefined,
      question: "Send a Discord message.",
      responseStyle: undefined,
      workingAction: undefined,
      workingMessage: undefined,
    });
  });

  it("builds configurable working responses for delegated consults", () => {
    expect(buildRealtimeVoiceAgentConsultWorkingResponse("caller")).toEqual({
      status: "working",
      tool: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      message:
        'Briefly tell the caller in their language that you are checking, for example: "Alles klar, ich schaue ganz kurz." Then wait for the final OpenClaw result before answering with the actual result.',
    });
    expect(
      buildRealtimeVoiceAgentConsultWorkingResponse({
        audienceLabel: "caller",
        workingAction: "checking the calendar",
      }),
    ).toEqual({
      status: "working",
      tool: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      message:
        "Briefly tell the caller in their language that you are checking the calendar. Then wait for the final OpenClaw result before answering with the actual result.",
    });
    expect(
      buildRealtimeVoiceAgentConsultWorkingResponse({
        audienceLabel: "caller",
        workingMessage: "Alles klar, ich pruefe den Kalender kurz.",
      }),
    ).toEqual({
      status: "working",
      tool: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      message:
        'Briefly tell the caller in their language: "Alles klar, ich pruefe den Kalender kurz." Then wait for the final OpenClaw result before answering with the actual result.',
    });
  });

  it("builds progress responses for long-running delegated consults", () => {
    expect(buildRealtimeVoiceAgentConsultProgressResponse({ audienceLabel: "caller" })).toEqual({
      status: "progress",
      tool: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      message:
        "Briefly reassure the caller in their language that you are still working and will answer as soon as you have the result.",
    });
    expect(
      buildRealtimeVoiceAgentConsultProgressResponse({
        audienceLabel: "caller",
        workingAction: "checking the weather forecast",
      }),
    ).toEqual({
      status: "progress",
      tool: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      message:
        "Briefly reassure the caller in their language that you are still checking the weather forecast and will answer as soon as you have the result.",
    });
  });

  it("builds a delegated voice request prompt with recent transcript", () => {
    const prompt = buildRealtimeVoiceAgentConsultPrompt({
      args: { question: "Do we support realtime tools?" },
      transcript: [
        { role: "user", text: "Can you check the repo?" },
        { role: "assistant", text: "I'll verify." },
      ],
      surface: "a private Google Meet",
      userLabel: "Participant",
      assistantLabel: "Agent",
      questionSourceLabel: "participant",
    });

    expect(prompt).toBe(
      [
        "Live voice request from the participant during a private Google Meet.",
        "Act as the configured OpenClaw agent on behalf of this user. Use available tools when the request asks you to do work.",
        "When finished, return only the concise result the realtime voice agent should speak back.",
        "Do not include markdown, tool logs, or private reasoning. Include citations only when the spoken answer needs them.",
        "Recent voice transcript for context:\nParticipant: Can you check the repo?\nAgent: I'll verify.",
        "User request:\nDo we support realtime tools?",
      ].join("\n\n"),
    );
  });

  it("filters reasoning and error payloads from visible consult output", () => {
    expect(
      collectRealtimeVoiceAgentConsultVisibleText([
        { text: "thinking", isReasoning: true },
        { text: "first" },
        { text: "error", isError: true },
        { text: "second" },
      ]),
    ).toBe("first\n\nsecond");
  });

  it("normalizes policy values and resolves shared tool exposure", () => {
    expect(resolveRealtimeVoiceAgentConsultToolPolicy(" OWNER ", "safe-read-only")).toBe("owner");
    expect(resolveRealtimeVoiceAgentConsultToolPolicy("bad", "safe-read-only")).toBe(
      "safe-read-only",
    );
    expect(resolveRealtimeVoiceAgentConsultTools("safe-read-only")).toStrictEqual([
      REALTIME_VOICE_AGENT_CONSULT_TOOL,
    ]);
    expect(resolveRealtimeVoiceAgentConsultTools("none")).toStrictEqual([]);
    expect(resolveRealtimeVoiceAgentConsultToolsAllow("safe-read-only")).toEqual([
      "read",
      "web_search",
      "web_fetch",
      "x_search",
      "memory_search",
      "memory_get",
    ]);
    expect(resolveRealtimeVoiceAgentConsultToolsAllow("owner")).toBeUndefined();
    expect(resolveRealtimeVoiceAgentConsultToolsAllow("none")).toStrictEqual([]);
  });

  it("keeps the shared consult tool ahead of custom realtime tools and dedupes by name", () => {
    const customTool = {
      type: "function" as const,
      name: "custom_lookup",
      description: "Custom lookup",
      parameters: { type: "object" as const, properties: {} },
    };
    const duplicateConsultTool = { ...customTool, name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME };

    expect(
      resolveRealtimeVoiceAgentConsultTools("safe-read-only", [duplicateConsultTool, customTool]),
    ).toStrictEqual([REALTIME_VOICE_AGENT_CONSULT_TOOL, customTool]);
    expect(resolveRealtimeVoiceAgentConsultTools("none", [customTool])).toEqual([customTool]);
  });
});
