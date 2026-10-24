import { describe, expect, it } from "vitest";
import {
  buildRealtimeVoiceAgentConsultChatMessage as buildChatMessage,
  buildRealtimeVoiceSessionInstructions as buildSessionInstructions,
  collectRealtimeVoiceAgentConsultVisibleText as collectVisibleText,
  parseRealtimeVoiceAgentConsultArgs as parseArgs,
  REALTIME_VOICE_AGENT_CONSULT_TOOL as consultTool,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME as consultName,
  resolveRealtimeVoiceAgentConsultToolPolicy as resolvePolicy,
  resolveRealtimeVoiceAgentConsultTools as resolveTools,
  resolveRealtimeVoiceAgentConsultToolsAllow as resolveToolsAllow,
  type RealtimeVoiceAgentConsultToolPolicy as ToolPolicy,
} from "./agent-consult-tool.js";
import type { RealtimeVoiceTool } from "./provider-types.js";

function sessionInstructions(options: Partial<Parameters<typeof buildSessionInstructions>[0]>) {
  return buildSessionInstructions({
    base: "Voice base.",
    isAgentProxy: true,
    toolPolicy: "owner",
    consultPolicy: "auto",
    ...options,
  });
}

const customTool: RealtimeVoiceTool = {
  type: "function",
  name: "custom_lookup",
  description: "Custom lookup",
  parameters: { type: "object", properties: {} },
};
const duplicateConsultTool = { ...customTool, name: consultName };
const unreadableNameTool: RealtimeVoiceTool = {
  ...customTool,
  get name(): string {
    throw new Error("unreadable tool name");
  },
};
const nonStringNameTool = { ...customTool, name: undefined } as unknown as RealtimeVoiceTool;

describe("realtime voice agent consult tool", () => {
  it("normalizes shared tool arguments for browser chat forwarding", () => {
    expect(
      buildChatMessage({
        question: "  What changed? ",
        context: "  PR #123 ",
        responseStyle: " concise ",
      }),
    ).toBe("What changed?\n\nContext:\nPR #123\n\nSpoken style:\nconcise");
  });

  it("does not accept a model-supplied spoken confirmation as authority", () => {
    const args = { question: "Send it now", confirmationId: " confirm-123 " };
    expect(parseArgs(args)).toStrictEqual({
      question: "Send it now",
      context: undefined,
      responseStyle: undefined,
    });
  });

  it("filters reasoning and error payloads from visible consult output", () => {
    expect(
      collectVisibleText([
        { text: "thinking", isReasoning: true },
        { text: "first" },
        { text: "error", isError: true },
        { text: "second" },
      ]),
    ).toBe("first\n\nsecond");
  });

  it("builds byte-stable agent-proxy session instructions", () => {
    expect(
      sessionInstructions({
        base: "You are OpenClaw's Discord voice interface.\nKeep spoken replies concise, natural, and suitable for a live Discord voice channel.",
        bootstrapContextInstructions: "  Profile context.  ",
        consultPolicy: "always",
      }),
    ).toBe(
      [
        "You are OpenClaw's Discord voice interface.\nKeep spoken replies concise, natural, and suitable for a live Discord voice channel.",
        "Profile context.",
        "Mode: OpenClaw agent proxy.",
        "You are the realtime voice surface for the same OpenClaw agent the user can message directly.",
        "Do not mention a backend, supervisor, helper, or separate system. Present the result as your own work.",
        "Delegate substantive requests, actions, tool work, current facts, memory, workspace context, and user-specific context with openclaw_agent_consult.",
        "Do not block, refuse, or downscope at the voice layer. Delegate to OpenClaw and treat its result as authoritative.",
        "Answer directly only for greetings, acknowledgements, brief latency tests, or filler while waiting.",
        'While waiting for OpenClaw data or tool results, use at most one short natural backchannel such as "yeah", "mm-hmm", "got it", or "one sec"; vary it and do not treat it as the final answer.',
        "When OpenClaw sends an internal exact answer to speak, do not call tools. Say only that answer.",
        [
          "Consult behavior:",
          "- Call openclaw_agent_consult before every substantive answer.",
          "- You may answer directly only for greetings, acknowledgements, brief latency tests, or filler while waiting for the consult result.",
          "- After the consult result arrives, speak that result concisely.",
        ].join("\n"),
      ].join("\n\n"),
    );
    expect(sessionInstructions({ toolPolicy: "none" })).toContain(
      "Voice base.\n\n\n\nMode: OpenClaw agent proxy.",
    );
  });

  it("filters empty optional blocks from non-proxy session instructions", () => {
    expect(
      sessionInstructions({
        isAgentProxy: false,
        bootstrapContextInstructions: "   ",
        toolPolicy: "safe-read-only",
      }),
    ).toBe(
      [
        "Voice base.",
        'While waiting for OpenClaw data or tool results, use at most one short natural backchannel such as "yeah", "mm-hmm", "got it", or "one sec"; vary it and do not treat it as the final answer.',
      ].join("\n\n"),
    );
  });

  it("normalizes policy values and resolves shared tool exposure", () => {
    expect(resolvePolicy(" OWNER ", "safe-read-only")).toBe("owner");
    expect(resolvePolicy("bad", "safe-read-only")).toBe("safe-read-only");
    expect(resolveToolsAllow("safe-read-only")).toEqual(
      "read web_search web_fetch x_search memory_search memory_get".split(" "),
    );
    expect(resolveToolsAllow("owner")).toBeUndefined();
    expect(resolveToolsAllow("none")).toStrictEqual([]);
  });

  it.each<[ToolPolicy, RealtimeVoiceTool[] | undefined, RealtimeVoiceTool[]]>([
    ["safe-read-only", undefined, [consultTool]],
    ["none", undefined, []],
    ["safe-read-only", [duplicateConsultTool, customTool], [consultTool, customTool]],
    ["none", [customTool], [customTool]],
    [
      "safe-read-only",
      [unreadableNameTool, nonStringNameTool, customTool],
      [consultTool, customTool],
    ],
    ["none", [unreadableNameTool, customTool], [customTool]],
  ])(
    "resolves %s tools with built-in precedence and malformed-name quarantine (%#)",
    (policy, custom, expected) => {
      expect(resolveTools(policy, custom)).toStrictEqual(expected);
    },
  );
});
