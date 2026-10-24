import { describe, expect, it } from "vitest";
import {
  extractToolPayload,
  parseStandalonePlainTextToolCallBlocks as parse,
  stripPlainTextToolCallBlocks,
  type ToolPayloadCarrier,
} from "./tool-payload.js";

function expectStripped(block: string, after = "after") {
  expect(stripPlainTextToolCallBlocks(`before\n${block}\n${after}`)).toBe(`before\n${after}`);
}
const xmlParameter = (name: string, value: string) => `<parameter=${name}>${value}</parameter>`;
const xmlCall = (name: string, body = "") => `<function=${name}>${body}</function>`;
function parseAllowed(raw: string, name: string, maxPayloadBytes?: number) {
  return parse(raw, { allowedToolNames: [name], maxPayloadBytes });
}
const image = { type: "image" };

describe("extractToolPayload", () => {
  it("returns undefined for missing results", () => {
    expect(extractToolPayload(undefined)).toBeUndefined();
    expect(extractToolPayload(null)).toBeUndefined();
  });

  it("prefers explicit details payloads", () => {
    expect(
      extractToolPayload({
        details: { ok: true },
        content: [{ type: "text", text: '{"ignored":true}' }],
      }),
    ).toEqual({ ok: true });
  });

  it("parses JSON text blocks and falls back to raw text, content, or the whole result", () => {
    expect(
      extractToolPayload({
        content: [image, { type: "text", text: '{"ok":true,"count":2}' }],
      }),
    ).toEqual({ ok: true, count: 2 });

    expect(extractToolPayload({ content: [{ type: "text", text: "not json" }] })).toBe("not json");

    const content = [image];
    expect(extractToolPayload({ content })).toBe(content);

    const result = { status: "ok" } as ToolPayloadCarrier & { status: string };
    expect(extractToolPayload(result)).toBe(result);
  });
});

describe("parseStandalonePlainTextToolCallBlocks", () => {
  it("keeps bracketed openings from becoming zero-argument XML calls", () => {
    expect(parse("[get_system_info]\n</function>")).toBeNull();
  });

  it("counts XML body whitespace against the UTF-8 payload cap", () => {
    const immediate = "<function=get_system_info></function>";
    expect(parseAllowed(immediate, "get_system_info", 0)?.[0]?.arguments).toEqual({});

    const oversizedBody = "\u00a0".repeat(129);
    const oversized = `<function=get_system_info>${oversizedBody}</function>`;
    expect(new TextEncoder().encode(oversizedBody).byteLength).toBe(258);
    expect(parseAllowed(oversized, "get_system_info", 256)).toBeNull();
    expectStripped(oversized);

    const parameter = "<parameter=value>x</parameter>";
    const trailingBody = "\u00a0".repeat(2);
    const parameterBytes = new TextEncoder().encode(parameter).byteLength;
    expect(
      parseAllowed(
        xmlCall("get_system_info", parameter + trailingBody),
        "get_system_info",
        parameterBytes + 3,
      ),
    ).toBeNull();
  });

  it("preserves __proto__ as an own XML argument property", () => {
    const raw = "<function=write><parameter=__proto__>value</parameter></function>";
    const args = parse(raw)?.[0]?.arguments;

    expect(Object.getPrototypeOf(args)).toBe(Object.prototype);
    expect(Object.hasOwn(args ?? {}, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(args ?? {}, "__proto__")?.value).toBe("value");
  });

  it("materializes one-shot tool-name iterables once per parse", () => {
    function* allowedNames() {
      yield "exec";
    }
    const legacy = "[tool:exec]<parameter=command>pwd</parameter>";
    expect(parse(legacy, { allowedToolNames: allowedNames() })).toMatchObject([
      { name: "exec", arguments: { command: "pwd" } },
    ]);

    const adjacent = "<function=exec></function><function=exec></function>";
    expect(parse(adjacent, { allowedToolNames: allowedNames() })).toHaveLength(2);
  });

  it("finds XML parameter close tags without lowercased string offsets", () => {
    const dottedCapitalI = "\u0130";
    const raw = xmlCall("write", `\n${xmlParameter("content", `\n${dottedCapitalI}\n`)}\n`);
    const blocks = parseAllowed(raw, "write");

    expect(blocks?.[0]?.arguments).toEqual({ content: dottedCapitalI });
  });

  it("counts serialized JSON payload limits in UTF-8 bytes", () => {
    const payload = JSON.stringify({ content: "é".repeat(20) });
    const raw = ["[write]", payload, "[/write]"].join("\n");
    expect(payload.length).toBeLessThan(48);
    expect(new TextEncoder().encode(payload).byteLength).toBeGreaterThan(48);

    expect(parseAllowed(raw, "write", 48)).toBeNull();
  });

  it("respects allowed tool names for Harmony calls", () => {
    expect(
      parseAllowed('commentary to=write code {"path":"/tmp/file.txt","content":"x"}', "read"),
    ).toBeNull();
  });
});

describe("stripPlainTextToolCallBlocks", () => {
  it.each(["<function=read></function>", '[tool:read] {"path":"/tmp"}'])(
    "strips adjacent same-line calls after an initial XML call: %s",
    (second) => {
      const calls = `<function=read></function>${second}`;
      expectStripped(calls);
    },
  );

  it("strips complete JSON payloads over the UTF-8 cap", () => {
    const call = `[tool:read] ${JSON.stringify({ value: "é".repeat(128_001) })}`;
    expectStripped(call);
  });

  it("strips a complete optional-close call before an ambiguous close prefix", () => {
    const suffix = "</func";
    const block = ["[tool:exec]", "<parameter=command>", "pwd", "</parameter>"].join("\n");
    expectStripped(block, suffix);
  });

  it("strips oversized XML parameter tool calls without promoting them", () => {
    const largeValue = "x".repeat(140_000);
    const block = xmlCall(
      "write",
      ["first", "second"].map((name) => `\n${xmlParameter(name, `\n${largeValue}\n`)}`).join("") +
        "\n",
    );
    expect(parseAllowed(block, "write")).toBeNull();
    expectStripped(block);
  });
});
