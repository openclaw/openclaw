import { describe, expect, it } from "vitest";
import {
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
import type { RealtimeVoiceTool } from "./provider-types.js";

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
    });
    expect(
      parseRealtimeVoiceAgentConsultArgs({ query: "  Send a Discord message. " }),
    ).toStrictEqual({
      context: undefined,
      question: "Send a Discord message.",
      responseStyle: undefined,
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

  it("quarantines unreadable custom realtime tools before consult tool exposure", () => {
    const unreadableName = {
      type: "function" as const,
      name: "fuzzplugin_unreadable_name",
      description: "Bad name",
      parameters: { type: "object" as const, properties: {} },
    };
    Object.defineProperty(unreadableName, "name", {
      get() {
        throw new Error("fuzzplugin realtime tool name is unreadable");
      },
    });
    const unreadableDescription = {
      type: "function" as const,
      name: "fuzzplugin_unreadable_description",
      description: "Bad description",
      parameters: { type: "object" as const, properties: {} },
    };
    Object.defineProperty(unreadableDescription, "description", {
      get() {
        throw new Error("fuzzplugin realtime tool description is unreadable");
      },
    });
    const invalidParameters = {
      type: "function" as const,
      name: "fuzzplugin_invalid_schema",
      description: "Bad schema",
      parameters: { type: "array" as const, items: { type: "string" } },
    };
    const dynamicParameters = {
      type: "function" as const,
      name: "fuzzplugin_dynamic_schema",
      description: "Dynamic schema",
      parameters: {
        type: "object" as const,
        properties: {
          target: { $dynamicRef: "#target" },
        },
      },
    };
    const arrayDynamicParameters = {
      type: "function" as const,
      name: "fuzzplugin_array_dynamic_schema",
      description: "Array dynamic schema",
      parameters: {
        type: "object" as const,
        anyOf: [{ $dynamicRef: "#target" }],
        properties: {},
      },
    };
    let flakyNameReads = 0;
    const flakyName = {
      type: "function" as const,
      name: "fuzzplugin_flaky_name",
      description: "Safe snapshot",
      parameters: { type: "object" as const, properties: {} },
    };
    Object.defineProperty(flakyName, "name", {
      get() {
        flakyNameReads += 1;
        if (flakyNameReads > 1) {
          throw new Error("fuzzplugin realtime tool name was reread");
        }
        return "fuzzplugin_flaky_name";
      },
    });

    const tools = resolveRealtimeVoiceAgentConsultTools("safe-read-only", [
      unreadableName,
      unreadableDescription,
      invalidParameters as unknown as RealtimeVoiceTool,
      dynamicParameters,
      arrayDynamicParameters,
      flakyName,
    ]);

    expect(tools.map((tool) => tool.name)).toEqual([
      REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      "fuzzplugin_flaky_name",
    ]);
    expect(tools[1]).toEqual({
      type: "function",
      name: "fuzzplugin_flaky_name",
      description: "Safe snapshot",
      parameters: { type: "object", properties: {} },
    });
    expect(flakyNameReads).toBe(1);
  });

  it("keeps custom realtime tools with dynamic-keyword argument names", () => {
    const literalDynamicNameTool = {
      type: "function" as const,
      name: "fuzzplugin_literal_dynamic_name",
      description: "Literal dynamic keyword argument name",
      parameters: {
        type: "object" as const,
        properties: {
          $dynamicRef: { type: "string" },
        },
      },
    };

    expect(resolveRealtimeVoiceAgentConsultTools("none", [literalDynamicNameTool])).toEqual([
      literalDynamicNameTool,
    ]);
  });
});
