// Tool payload tests cover model tool-call schema conversion and compatibility payloads.
import { describe, expect, it } from "vitest";
import {
  extractToolPayload,
  parseStandalonePlainTextToolCallBlocks,
  stripPlainTextToolCallBlocks,
  type ToolPayloadCarrier,
} from "./tool-payload.js";

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
        content: [
          { type: "image", url: "https://example.com/a.png" },
          { type: "text", text: '{"ok":true,"count":2}' },
        ],
      }),
    ).toEqual({ ok: true, count: 2 });

    expect(
      extractToolPayload({
        content: [{ type: "text", text: "not json" }],
      }),
    ).toBe("not json");

    const content = [{ type: "image", url: "https://example.com/a.png" }];
    expect(
      extractToolPayload({
        content,
      }),
    ).toBe(content);

    const result = { status: "ok" } as ToolPayloadCarrier & { status: string };
    expect(extractToolPayload(result)).toBe(result);
  });
});

describe("parseStandalonePlainTextToolCallBlocks", () => {
  it.each(["[get_system_info]\n</function>"])(
    "keeps bracketed opening %s from becoming a zero-argument XML call",
    (raw) => {
      expect(parseStandalonePlainTextToolCallBlocks(raw)).toBeNull();
    },
  );

  it("counts XML body whitespace against the UTF-8 payload cap", () => {
    const immediate = "<function=get_system_info></function>";
    expect(
      parseStandalonePlainTextToolCallBlocks(immediate, {
        allowedToolNames: ["get_system_info"],
        maxPayloadBytes: 0,
      })?.[0]?.arguments,
    ).toEqual({});

    const oversizedBody = "\u00a0".repeat(129);
    const oversized = `<function=get_system_info>${oversizedBody}</function>`;
    expect(new TextEncoder().encode(oversizedBody).byteLength).toBe(258);
    expect(
      parseStandalonePlainTextToolCallBlocks(oversized, {
        allowedToolNames: ["get_system_info"],
        maxPayloadBytes: 256,
      }),
    ).toBeNull();
    expect(stripPlainTextToolCallBlocks(["before", oversized, "after"].join("\n"))).toBe(
      "before\nafter",
    );

    const parameter = "<parameter=value>x</parameter>";
    const trailingBody = "\u00a0".repeat(2);
    const parameterBytes = new TextEncoder().encode(parameter).byteLength;
    expect(
      parseStandalonePlainTextToolCallBlocks(
        `<function=get_system_info>${parameter}${trailingBody}</function>`,
        {
          allowedToolNames: ["get_system_info"],
          maxPayloadBytes: parameterBytes + 3,
        },
      ),
    ).toBeNull();
  });

  it("preserves __proto__ as an own XML argument property", () => {
    const raw = "<function=write><parameter=__proto__>value</parameter></function>";
    const args = parseStandalonePlainTextToolCallBlocks(raw)?.[0]?.arguments;

    expect(Object.getPrototypeOf(args)).toBe(Object.prototype);
    expect(Object.hasOwn(args ?? {}, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(args ?? {}, "__proto__")?.value).toBe("value");
  });

  it("materializes one-shot tool-name iterables once per parse", () => {
    function* allowedNames() {
      yield "exec";
    }
    const legacy = "[tool:exec]<parameter=command>pwd</parameter>";
    expect(
      parseStandalonePlainTextToolCallBlocks(legacy, { allowedToolNames: allowedNames() }),
    ).toMatchObject([{ name: "exec", arguments: { command: "pwd" } }]);

    const adjacent = "<function=exec></function><function=exec></function>";
    expect(
      parseStandalonePlainTextToolCallBlocks(adjacent, { allowedToolNames: allowedNames() }),
    ).toHaveLength(2);
  });

  it("finds XML parameter close tags without lowercased string offsets", () => {
    const dottedCapitalI = "\u0130";
    const raw = [
      "<function=write>",
      "<parameter=content>",
      dottedCapitalI,
      "</parameter>",
      "</function>",
    ].join("\n");
    const blocks = parseStandalonePlainTextToolCallBlocks(raw, {
      allowedToolNames: ["write"],
    });

    expect(blocks?.[0]?.arguments).toEqual({ content: dottedCapitalI });
  });

  it("counts serialized JSON payload limits in UTF-8 bytes", () => {
    const payload = JSON.stringify({ content: "é".repeat(20) });
    const raw = ["[write]", payload, "[/write]"].join("\n");
    expect(payload.length).toBeLessThan(48);
    expect(new TextEncoder().encode(payload).byteLength).toBeGreaterThan(48);

    expect(
      parseStandalonePlainTextToolCallBlocks(raw, {
        allowedToolNames: ["write"],
        maxPayloadBytes: 48,
      }),
    ).toBeNull();
  });

  it("respects allowed tool names for Harmony calls", () => {
    const blocks = parseStandalonePlainTextToolCallBlocks(
      'commentary to=write code {"path":"/tmp/file.txt","content":"x"}',
      { allowedToolNames: ["read"] },
    );

    expect(blocks).toBeNull();
  });
});

describe("stripPlainTextToolCallBlocks", () => {
  it.each(["<function=read></function>", '[tool:read] {"path":"/tmp"}'])(
    "strips adjacent same-line calls after an initial XML call: %s",
    (second) => {
      const calls = `<function=read></function>${second}`;
      expect(stripPlainTextToolCallBlocks(`before\n${calls}\nafter`)).toBe("before\nafter");
    },
  );

  it("strips complete JSON payloads over the UTF-8 cap", () => {
    const call = `[tool:read] ${JSON.stringify({ value: "é".repeat(128_001) })}`;
    expect(stripPlainTextToolCallBlocks(`before\n${call}\nafter`)).toBe("before\nafter");
  });

  it.each(["</func"])(
    "strips a complete optional-close call before an ambiguous %s prefix",
    (suffix) => {
      const block = ["[tool:exec]", "<parameter=command>", "pwd", "</parameter>"].join("\n");
      expect(stripPlainTextToolCallBlocks(["before", block, suffix].join("\n"))).toBe(
        `before\n${suffix}`,
      );
    },
  );

  it("strips oversized XML parameter tool calls without promoting them", () => {
    const largeValue = "x".repeat(140_000);
    const block = [
      "<function=write>",
      "<parameter=first>",
      largeValue,
      "</parameter>",
      "<parameter=second>",
      largeValue,
      "</parameter>",
      "</function>",
    ].join("\n");

    expect(
      parseStandalonePlainTextToolCallBlocks(block, {
        allowedToolNames: ["write"],
      }),
    ).toBeNull();
    expect(stripPlainTextToolCallBlocks(["before", block, "after"].join("\n"))).toBe(
      "before\nafter",
    );
  });
});
