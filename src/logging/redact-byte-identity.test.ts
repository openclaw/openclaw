import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  redactLogRecordForTransport,
  redactModelVisibleToolPayloadText,
  redactModelVisibleToolPayloadTextWithConfig,
  redactSensitiveFieldValue,
  redactSensitiveText,
  redactToolPayloadText,
  redactToolPayloadTextWithConfig,
} from "./redact.js";

// Recorded outputs from the pre-fix implementation (git HEAD before the boundary-leak fix)
// over a deterministic corpus. Whole-text matching must keep every text under the old
// 32,768-character slicing threshold byte-identical through each entry point.
type Fixture = {
  samples: string[];
  outputs: [string, string, string, string][];
};

const fixture = JSON.parse(
  readFileSync(new URL("./redact-byte-identity-fixture.json", import.meta.url), "utf8"),
) as Fixture;

// Fixture corpora store the ":" of every "://" as a literal 3-char @@S marker (slashes kept)
// so secret scanners never see a complete scheme:// pattern in the JSON; restore both
// sides before comparing.
// The substitution is identical on samples and recorded outputs, so the comparison stays
// byte-equivalent to the original pre-fix recording.
const restoreSchemes = (text: string): string => text.replace(/@@S/g, ":");

it("fixture is present and bounded by the old slicing threshold", () => {
  expect(fixture.samples.length).toBeGreaterThan(200);
  for (const sample of fixture.samples) {
    expect(sample.length).toBeLessThanOrEqual(32_768);
  }
});

it("redacts short texts byte-identically to the pre-fix implementation", () => {
  for (let index = 0; index < fixture.samples.length; index++) {
    const sample = restoreSchemes(fixture.samples[index]!);
    const [sensitive, toolPayload, modelVisible, logRecord] =
      fixture.outputs[index]!.map(restoreSchemes);
    expect(redactSensitiveText(sample, { mode: "tools" })).toBe(sensitive);
    expect(redactToolPayloadText(sample)).toBe(toolPayload);
    expect(redactModelVisibleToolPayloadText(sample)).toBe(modelVisible);
    expect(JSON.stringify(redactLogRecordForTransport({ message: sample, level: "info" }))).toBe(
      logRecord,
    );
  }
});

it("preserves baseline bytes across secret families, near misses, and ordered compositions", () => {
  // Recorded from the untouched baseline named in the fixture, before prefilter changes.
  // Hash the complete outputs together to keep the seven-mode corpus small without
  // deriving expected values from the current implementation or storing masked duplicates.
  // JSON escapes keep synthetic PEM markers out of repository bytes; parsing restores them.
  const corpus = JSON.parse(
    readFileSync(new URL("./redact-prefilter-fixture.json", import.meta.url), "utf8"),
  ) as { cases: [name: string, input: string, sha256: string][] };
  for (const [name, input, sha256] of corpus.cases) {
    const text = restoreSchemes(input);
    const outputs = [
      redactSensitiveText(text),
      redactSensitiveText(text, { mode: "tools" }),
      redactSensitiveText(text, { mode: "off" }),
      redactSensitiveFieldValue("content", text, { mode: "tools" }),
      redactSensitiveFieldValue("token", text, { mode: "tools" }),
      redactToolPayloadTextWithConfig(text, {}),
      redactModelVisibleToolPayloadTextWithConfig(text, {}),
    ];
    expect(createHash("sha256").update(JSON.stringify(outputs)).digest("hex"), name).toBe(sha256);
  }
});
