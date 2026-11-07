import { describe, expect, it, vi } from "vitest";
import type { CapabilityEnvelope } from "./metadata.js";
import { emitJsonOrText, formatEnvelopeForText, providerSummaryText } from "./output.js";

const envelope: CapabilityEnvelope = {
  ok: true,
  capability: "model.run",
  transport: "local",
  attempts: [],
  outputs: [],
};
const unsafe = "\u001b[31mred\u001b[0m\nnext\t\r\u0085\u202e🚀";
const singleLine = "red\\nnext\\t\\r🚀";
const multiline = "red\nnext\\t\\r🚀";

describe("inference terminal output", () => {
  it("keeps metadata on owned lines while preserving multiline text and input data", () => {
    const value: CapabilityEnvelope = {
      ...envelope,
      provider: unsafe,
      model: unsafe,
      ignoredOverrides: [{ source: "\u0085\u202eplain" }],
      outputs: [
        { path: unsafe, text: unsafe },
        { path: "", text: "" },
        { path: 42, text: false },
        { value: "\u0085\u202eplain" },
        { path: "\u001b[0m" },
      ],
    };
    const before = structuredClone(value);
    expect(formatEnvelopeForText(value)).toBe(
      [
        "model.run via local",
        `provider: ${singleLine}`,
        `model: ${singleLine}`,
        'ignoredOverrides: [{"source":"plain"}]',
        "outputs: 5",
        singleLine,
        multiline,
        '{"path":"","text":""}',
        '{"path":42,"text":false}',
        '{"value":"plain"}',
        "",
      ].join("\n"),
    );
    expect(value).toEqual(before);
  });

  it.each([
    { name: "missing", error: undefined, expected: "unknown error" },
    { name: "empty", error: "", expected: "" },
    { name: "untrusted", error: unsafe, expected: singleLine },
  ])("renders $name errors on one owned line", ({ error, expected }) => {
    expect(formatEnvelopeForText({ ...envelope, ok: false, error })).toBe(
      `model.run failed: ${expected}`,
    );
  });

  it.each([
    { name: "empty", text: "", embedding: [], dimensions: 0, preview: "[]" },
    { name: "short", text: unsafe, embedding: [0.1, -0.2], dimensions: 2, preview: "[0.1, -0.2]" },
    {
      name: "long",
      text: unsafe,
      embedding: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      dimensions: 9,
      preview: "[1, 2, 3, 4, 5, 6, 7, 8, ...]",
    },
  ])(
    "preserves $name embedding previews and text layout",
    ({ text, embedding, dimensions, preview }) => {
      expect(
        formatEnvelopeForText({
          ...envelope,
          capability: "embedding.create",
          outputs: [{ text, embedding, dimensions }],
        }),
      ).toBe(
        [
          "embedding.create via local",
          "outputs: 1",
          text ? multiline : "",
          `dimensions: ${dimensions}`,
          `embedding: ${preview}`,
        ].join("\n"),
      );
    },
  );

  it("sanitizes embedding display scalars without altering their source values", () => {
    const value = {
      ...envelope,
      capability: "embedding.create",
      outputs: [{ embedding: [unsafe], dimensions: unsafe, text: 42 }],
    };
    const before = structuredClone(value);
    expect(formatEnvelopeForText(value)).toBe(
      `embedding.create via local\noutputs: 1\n\ndimensions: ${singleLine}\nembedding: [${singleLine}]`,
    );
    expect(value).toEqual(before);
  });

  it("keeps empty headers absent and escapes controls left by JSON stringification", () => {
    expect(
      formatEnvelopeForText({ ...envelope, provider: "", model: "", ignoredOverrides: [] }),
    ).toBe("model.run via local\noutputs: 0");
    expect(providerSummaryText([undefined, { id: "\u0085\u202eplain" }, null, 0, ""])).toBe(
      '\n{"id":"plain"}\nnull\n0\n""',
    );
    expect(providerSummaryText([])).toBe("No results found.");
    expect(providerSummaryText([undefined])).toBe("No results found.");
  });

  it("emits unchanged JSON without applying terminal formatting", () => {
    const value = { ...envelope, provider: unsafe, outputs: [{ text: unsafe, embedding: [1, 0] }] };
    const before = structuredClone(value);
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const format = vi.fn(formatEnvelopeForText);
    emitJsonOrText(runtime, true, value, format);
    expect(runtime.log).toHaveBeenCalledExactlyOnceWith(JSON.stringify(before, null, 2));
    expect(format).not.toHaveBeenCalled();
    expect(value).toEqual(before);
  });
});
