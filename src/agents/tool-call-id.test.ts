import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it } from "vitest";
import { castAgentMessages } from "./test-helpers/agent-message-fixtures.js";
import { sparseAssistant } from "./test-helpers/sparse-transcript.test-support.js";
import { sanitizeToolCallIdsForCloudCodeAssist as sanitize } from "./tool-call-id.js";

type Mode = "strict" | "strict9";
const call = (id: string, name = "read") => ({
  type: "toolCall" as const,
  id,
  name,
  arguments: {},
});
const result = (toolCallId: string, text = "ok", aliases = false, toolName = "read") => ({
  role: "toolResult" as const,
  toolCallId,
  ...(aliases ? { toolUseId: toolCallId } : {}),
  toolName,
  content: [{ type: "text" as const, text }],
});
const transcript = (...ids: string[]) =>
  castAgentMessages([sparseAssistant(ids.map((id) => call(id))), ...ids.map((id) => result(id))]);
const repeatedTurns = () =>
  castAgentMessages(
    ["one", "two"].flatMap((text) => [
      sparseAssistant([call("functions.read:0")]),
      result("functions.read:0", text),
    ]),
  );
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
const sanitizeId = (id: string, mode: Mode = "strict") => idAt(sanitize(transcript(id), mode));

function expectPair(out: AgentMessage[], mode: Mode, aliases = false) {
  const ids = [idAt(out, 0, 0), idAt(out, 0, 1)];
  expect(ids[0]).not.toBe(ids[1]);
  ids.forEach((id, i) => {
    expect(typeof id).toBe("string");
    expect(sanitizeId(id, mode)).toBe(id);
    expect(out[i + 1]).toMatchObject({ toolCallId: id, ...(aliases ? { toolUseId: id } : {}) });
    if (mode === "strict9") {
      expect(id).toHaveLength(9);
    }
  });
  return ids;
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
    const input = transcript(mode === "strict" ? "call1" : "abc123XYZ");
    expect(sanitize(input, mode)).toBe(input);
  });

  it("strips non-alphanumeric characters", () => {
    expectRewrite(transcript("call_|item:123-"), "callitem123", "strict");
  });

  it.each<Mode>(["strict", "strict9"])("pairs repeated IDs and aliases in %s mode", (mode) => {
    const input = castAgentMessages([
      sparseAssistant([call("edit:22", "edit"), call("edit:22", "edit")]),
      ...["one", "two"].map((text) => result("edit:22", text, true, "edit")),
    ]);
    const out = sanitize(input, mode);
    expect(out).not.toBe(input);
    expectPair(out, mode, true);
  });

  it("caps IDs at 40 characters without collisions", () => {
    const out = sanitize(transcript(`call_${"a".repeat(60)}`, `call_${"a".repeat(59)}b`));
    for (const id of expectPair(out, "strict")) {
      expect(id.length).toBeLessThanOrEqual(40);
    }
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
    expect(out).not.toBe(input);
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
    const out = sanitize(input, "strict", replayOptions);
    expect(out).toBe(input);
    expect(idAt(out, 0, 1)).toBe("call_1");
    expect(out[1]).toMatchObject({ toolCallId: "call_1" });
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
      expect(out).not.toBe(input);
      const first = idAt(out, 0, firstSigned ? 1 : 0);
      const second = idAt(out, 2, 1);
      expect(firstSigned ? first : second).toBe("call1");
      expect(firstSigned ? second : first).not.toBe("call1");
      expect(first).not.toBe(second);
      expect(out[1]).toMatchObject({ toolCallId: first });
      expect(out[3]).toMatchObject({ toolCallId: second });
    },
  );

  it("uses alphanumeric-only collision suffixes", () => {
    const input = transcript("call_a|b", "call_a:b");
    const out = sanitize(input);
    expect(out).not.toBe(input);
    for (const id of expectPair(out, "strict")) {
      expect(id).not.toMatch(/[_-]/);
    }
  });

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

  it("preserves native Kimi formats only in strict mode", () => {
    for (const id of ["functions.read:0", "functions.bash_tool:12", "functions.edit-file:3"]) {
      expect(sanitizeId(id)).toBe(id);
    }
    expect(sanitizeId("functions.read:0", "strict9")).not.toBe("functions.read:0");
  });

  it("preserves native Kimi IDs alongside non-Kimi siblings", () => {
    const input = transcript("functions.read:0", "call_a|b");
    const out = sanitize(input);
    expect(out).not.toBe(input);
    expect([idAt(out), idAt(out, 0, 1)]).toEqual(["functions.read:0", "callab"]);
    expect(out[1]).toMatchObject({ toolCallId: "functions.read:0" });
    expect(out[2]).toMatchObject({ toolCallId: "callab" });
  });

  it.each([false, true])("disambiguates repeated native Kimi IDs (OpenAI style: %s)", (openai) => {
    const input = repeatedTurns();
    const options = openai ? { duplicateToolCallIdStyle: "openai" as const } : undefined;
    const out = sanitize(input, "strict", options);
    expect(out).not.toBe(input);
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
    for (const id of [
      "functions.read",
      "functions.:0",
      "functions.read:",
      "functions.read:x",
      "functions.read:0:extra",
      "xfunctions.read:0",
    ]) {
      expect(sanitizeId(id)).not.toBe(id);
    }
  });

  it("enforces distinct 9-character alphanumeric IDs", () => {
    const input = transcript("call_abc|item:123", "call_abc|item:456");
    const out = sanitize(input, "strict9");
    expect(out).not.toBe(input);
    expectPair(out, "strict9");
  });

  it("rewrites native Kimi IDs in strict9 mode", () => {
    expectRewrite(transcript("functions.read:0"), "functions", "strict9");
  });
});
