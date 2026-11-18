import { describe, expect, it } from "vitest";
import { ExpectedCliError } from "../expected-cli-error.js";
import { parseOptionalPositiveInteger } from "../parse-positive-integer.js";
import type { CapabilityEnvelope } from "./metadata.js";
import { formatEnvelopeForText, providerSummaryText } from "./output.js";
import { parseOptionalTimeoutMs, requireProviderModelOverride } from "./shared.js";

describe("capability CLI model overrides", () => {
  it.each([undefined, "", " \t"])("keeps a blank override %j absent", (raw) => {
    expect(requireProviderModelOverride(raw)).toBeUndefined();
  });

  it.each(["model", "/model", "provider/"])("rejects incomplete override %j", (raw) => {
    expect(() => requireProviderModelOverride(raw)).toThrow(
      "Model overrides must use the form <provider/model>.",
    );
  });

  it("preserves model paths and segment whitespace after trimming the override", () => {
    expect(requireProviderModelOverride(" provider / model/revision ")).toEqual({
      provider: "provider ",
      model: " model/revision",
    });
  });
});

describe("capability CLI numeric option parsing", () => {
  it("keeps omitted optional values absent and parses valid values", () => {
    expect(parseOptionalPositiveInteger(undefined, "--limit")).toBeUndefined();
    expect(parseOptionalPositiveInteger("3", "--limit")).toBe(3);

    expect(parseOptionalTimeoutMs(undefined)).toBeUndefined();
    expect(parseOptionalTimeoutMs("1200")).toBe(1200);
  });

  it.each(["", "  ", "abc", 0, 1.5])("rejects invalid --limit %j", (raw) => {
    const parse = () => parseOptionalPositiveInteger(raw, "--limit");
    expect(parse).toThrow(ExpectedCliError);
    expect(parse).toThrow("--limit must be a positive integer");
  });

  it.each(["", "  ", "1000ms"])("rejects invalid --timeout-ms value %j", (raw) => {
    // A substring match would still pass on a message that names the wrong flag.
    expect(() => parseOptionalTimeoutMs(raw)).toThrow(
      "Invalid --timeout-ms. Use a positive millisecond value, e.g. --timeout-ms 30000.",
    );
  });
});

it("sanitizes envelope values and summaries without flattening multiline bodies", () => {
  const envelope: CapabilityEnvelope = {
    ok: true,
    capability: "\u001b[31mmodel.run",
    transport: "local",
    provider: "provider\u202e",
    model: "model\u0085",
    attempts: [],
    ignoredOverrides: [{ field: "\u202e" }],
    outputs: [
      { path: "file\npath", text: "first\u001b]2;title\u0007\nsecond\tcolumn" },
      { value: "\u202e" },
    ],
  };
  expect(formatEnvelopeForText(envelope)).toBe(
    'model.run via local\nprovider: provider\nmodel: model\nignoredOverrides: [{"field":""}]\noutputs: 2\nfile\\npath\nfirst\nsecond\\tcolumn\n{"value":""}',
  );
  expect(formatEnvelopeForText({ ...envelope, ok: false, error: "fail\u0007\nnext" })).toBe(
    "model.run failed: fail\\nnext",
  );
  expect(providerSummaryText([undefined, { name: "\u202e" }])).toBe('\n{"name":""}');
});
