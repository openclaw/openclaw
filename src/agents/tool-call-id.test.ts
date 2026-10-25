import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it } from "vitest";
import { castAgentMessages } from "./test-helpers/agent-message-fixtures.js";
import { sparseAssistant, textToolResult } from "./test-helpers/sparse-transcript.test-support.js";
import { sanitizeToolCallIdsForCloudCodeAssist as sanitize } from "./tool-call-id.js";

type Mode = "strict" | "strict9";
const call = (id: string) => ({
  type: "toolCall" as const,
  id,
  name: "read",
  arguments: {},
});
const result = (toolCallId: string, text = "ok", aliases = false) => ({
  ...textToolResult(toolCallId, "read", text),
  ...(aliases ? { toolUseId: toolCallId } : {}),
});
const transcript = (ids: readonly string[], aliases = false) =>
  castAgentMessages([
    sparseAssistant(ids.map(call)),
    ...ids.map((id) => result(id, "ok", aliases)),
  ]);
const signed = (signature: string, id: string) => ({
  role: "assistant" as const,
  content: [
    { type: "thinking" as const, thinking: "internal", thinkingSignature: signature },
    call(id),
  ],
});
function idAt(out: AgentMessage[], message = 0, block = 0): string {
  const { id } = (out[message] as Extract<AgentMessage, { role: "assistant" }>).content[block] as {
    id?: string;
  };
  if (!id) {
    throw new Error("expected sanitized tool-call id");
  }
  return id;
}
const sanitizeId = (id: string, mode: Mode = "strict") => idAt(sanitize(transcript([id]), mode));

function expectPair(out: AgentMessage[], mode: Mode, aliases = false) {
  const ids = [idAt(out, 0, 0), idAt(out, 0, 1)];
  expect(ids[0]).not.toBe(ids[1]);
  ids.forEach((id, i) => {
    expect(id).toMatch(/^[a-zA-Z0-9]+$/);
    expect(id.length).toBeLessThanOrEqual(40);
    expect(sanitizeId(id, mode)).toBe(id);
    expect(out[i + 1]).toMatchObject({ toolCallId: id, ...(aliases ? { toolUseId: id } : {}) });
    if (mode === "strict9") {
      expect(id).toHaveLength(9);
    }
  });
}
function expectRewrite(input: AgentMessage[], expectedId: string, mode: Mode) {
  const out = sanitize(input, mode);
  expect(out).not.toBe(input);
  expect(idAt(out)).toBe(expectedId);
  expect(sanitizeId(expectedId, mode)).toBe(expectedId);
  expect(out[1]).toMatchObject({ toolCallId: expectedId });
}

describe("sanitizeToolCallIdsForCloudCodeAssist", () => {
  it.each<Mode>(["strict", "strict9"])("preserves valid IDs in %s mode", (mode) => {
    const input = transcript([mode === "strict" ? "call1" : "abc123XYZ"]);
    expect(sanitize(input, mode)).toBe(input);
  });

  it("strips non-alphanumeric characters", () => {
    expectRewrite(transcript(["call_|item:123-"]), "callitem123", "strict");
  });

  it.each([
    ["repeated aliases", ["edit:22", "edit:22"], "strict", true],
    ["repeated aliases", ["edit:22", "edit:22"], "strict9", true],
    ["40-character collisions", ["a".repeat(60), "a".repeat(59) + "b"], "strict", false],
    ["punctuation collisions", ["call_a|b", "call_a:b"], "strict", false],
    ["9-character collisions", ["call_abc|item:123", "call_abc|item:456"], "strict9", false],
  ] as const)("pairs %s (%j, %s mode)", (_name, ids, mode, aliases) => {
    expectPair(sanitize(transcript(ids, aliases), mode), mode, aliases);
  });

  it("preserves native Anthropic IDs while sanitizing mixed-provider IDs", () => {
    const native = "toolu_01ABCDEF1234567890";
    const foreign = "call_123|fc_123";
    const toolUse = (id: string, path: string) => ({
      type: "toolUse",
      id,
      name: "read",
      input: { path },
    });
    const input = castAgentMessages([
      sparseAssistant([toolUse(native, "IDENTITY.md"), toolUse(foreign, "README.md")]),
      result(native, "identity", true),
      result(foreign, "readme", true),
    ]);
    const out = sanitize(input, "strict", { preserveNativeAnthropicToolUseIds: true });
    expect((out[0] as Extract<AgentMessage, { role: "assistant" }>).content).toEqual([
      toolUse(native, "IDENTITY.md"),
      toolUse("call123fc123", "README.md"),
    ]);
    expect(out[1]).toMatchObject({ toolCallId: native, toolUseId: native });
    expect(out[2]).toMatchObject({ toolCallId: "call123fc123", toolUseId: "call123fc123" });
  });

  const replayOptions = { preserveReplaySafeThinkingToolCallIds: true, allowedToolNames: ["read"] };
  it("preserves replay-safe signed-thinking IDs", () => {
    const input = castAgentMessages([signed("sig_1", "call_1"), result("call_1")]);
    expect(sanitize(input, "strict", replayOptions)).toBe(input);
  });

  it.each([false, true])(
    "reserves signed IDs before mutable IDs (first signed: %s)",
    (firstSigned) => {
      const input = castAgentMessages([
        firstSigned ? signed("sig_1", "call1") : sparseAssistant([call("call_1")]),
        result(firstSigned ? "call1" : "call_1", "first"),
        signed("sig_2", "call1"),
        result("call1", "second"),
      ]);
      const out = sanitize(input, "strict", replayOptions);
      const first = idAt(out, 0, firstSigned ? 1 : 0);
      const second = idAt(out, 2, 1);
      expect(firstSigned ? first : second).toBe("call1");
      expect(firstSigned ? second : first).not.toBe("call1");
      expect(out[1]).toMatchObject({ toolCallId: first });
      expect(out[3]).toMatchObject({ toolCallId: second });
    },
  );

  it.each([false, true])(
    "rewrites OpenAI result aliases (canonical ID present: %s)",
    (canonical) => {
      const raw = "call_mock_image_generate_1";
      const expected = "callmockimagegenerate1";
      const aliases = canonical
        ? { toolCallId: expected, call_id: raw }
        : { call_id: raw, callId: raw, tool_call_id: raw, tool_use_id: raw };
      const input = castAgentMessages([
        sparseAssistant([call(raw)]),
        {
          role: "toolResult",
          ...aliases,
          toolName: "image_generate",
          content: [{ type: "text", text: "Background task started" }],
        },
      ]);
      const out = sanitize(input);
      expect(idAt(out)).toBe(expected);
      expect(out[1]).toMatchObject(
        Object.fromEntries(["toolCallId", ...Object.keys(aliases)].map((key) => [key, expected])),
      );
    },
  );

  it("preserves native Kimi IDs alongside non-Kimi siblings", () => {
    const input = transcript(["functions.read:0", "call_a|b"]);
    const out = sanitize(input);
    expect([idAt(out), idAt(out, 0, 1)]).toEqual(["functions.read:0", "callab"]);
    expect(out[1]).toMatchObject({ toolCallId: "functions.read:0" });
    expect(out[2]).toMatchObject({ toolCallId: "callab" });
  });

  it.each([false, true])("disambiguates repeated native Kimi IDs (OpenAI style: %s)", (openai) => {
    const input = castAgentMessages(
      ["one", "two"].flatMap((text) => [
        sparseAssistant([call("functions.read:0")]),
        result("functions.read:0", text),
      ]),
    );
    const options = openai ? { duplicateToolCallIdStyle: "openai" as const } : undefined;
    const out = sanitize(input, "strict", options);
    const first = idAt(out);
    const second = idAt(out, 2);
    expect(first).toBe("functions.read:0");
    expect(second).not.toBe(first);
    expect(out[1]).toMatchObject({ toolCallId: first });
    expect(out[3]).toMatchObject({ toolCallId: second });
    if (openai) {
      expect(second).toMatch(/^call_[a-f0-9]{24}$/);
      expect(sanitize(out, "strict", options)).toBe(out);
    } else {
      expect(sanitizeId(second)).toBe(second);
    }
  });

  it("does not preserve malformed Kimi-like IDs", () => {
    expect(sanitizeId("functions.read:x")).toBe("functionsreadx");
  });

  it("rewrites native Kimi IDs in strict9 mode", () => {
    expectRewrite(transcript(["functions.read:0"]), "functions", "strict9");
  });
});
