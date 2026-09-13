// RED pins for review-143937 (issue #142821): 4 blocked findings.
// P1 redact.ts maskToken passthrough; P2 codec literal/escape/prefilter.
import {
  REDACTION_PROVENANCE_END,
  REDACTION_PROVENANCE_ESCAPE,
  REDACTION_PROVENANCE_START,
  escapeRawRedactionProvenanceLiterals,
  escapeRedactionProvenanceLiterals,
  markRedactionProvenance,
  replaceRedactionProvenance,
} from "@openclaw/normalization-core/redaction-provenance";
import { describe, expect, it } from "vitest";
import { redactSensitiveFieldValueWithConfig, redactSensitiveText } from "./redact.js";
import { registerSecretValueForRedaction } from "./secret-redaction-registry.js";

const PLACEHOLDER = "[redacted: re-derive this value, do not reuse]";

function redactPassword(value: string): string {
  return redactSensitiveFieldValueWithConfig("password", value, {});
}

describe("review-143937 P1: complete marker-shaped secrets stay subject to masking", () => {
  it("masks a raw password that equals a complete mark", () => {
    const secret = `${REDACTION_PROVENANCE_START}pwP1a…z8x2${REDACTION_PROVENANCE_END}`;
    expect(redactPassword(secret)).not.toBe(secret);
  });

  it("masks a registered secret whose value is a complete mark", () => {
    const secret = `${REDACTION_PROVENANCE_START}regP1b…q9z4${REDACTION_PROVENANCE_END}`;
    registerSecretValueForRedaction(secret);
    const redacted = redactSensitiveText(`value ${secret} end`, { mode: "tools" });
    expect(redacted).not.toContain(secret);
  });

  it("leaves bare *** alone (no double masking)", () => {
    expect(redactPassword("***")).toBe("***");
  });
});

describe("review-143937 P2: literal marks, escape pairs, prefilter", () => {
  it("preserves a user-typed literal complete mark once the write path pre-escapes it", () => {
    // Write-path contract (#142821 review): raw input is escaped first, so a user-typed
    // complete mark cannot survive as generated provenance. The pre-escaped literal plus
    // a fresh producer mark round-trips the literal byte-identical while replacing the mark.
    const literal = `${REDACTION_PROVENANCE_START}***${REDACTION_PROVENANCE_END}`;
    const escapedLiteral = escapeRawRedactionProvenanceLiterals(literal);
    expect(escapedLiteral).not.toBe(literal);
    const fresh = markRedactionProvenance("sk-abc…0xyz");
    const stored = escapeRedactionProvenanceLiterals(`${escapedLiteral} ${fresh}`);
    expect(replaceRedactionProvenance(stored, PLACEHOLDER)).toBe(`${literal} ${PLACEHOLDER}`);
  });

  it("does not read a literal complete mark as provenance when no fresh mark was produced", () => {
    // The same literal without the genuine mark (#142821 review): pre-escaping alone must
    // already make the bytes literal, so a reader leaves them instead of replacing what
    // the writer actually stored.
    const literal = `${REDACTION_PROVENANCE_START}***${REDACTION_PROVENANCE_END}`;
    const escapedLiteral = escapeRawRedactionProvenanceLiterals(literal);
    expect(escapedLiteral).not.toBe(literal);
    const stored = escapeRedactionProvenanceLiterals(escapedLiteral);
    expect(stored).toBe(escapedLiteral);
    expect(replaceRedactionProvenance(stored, PLACEHOLDER)).toBe(stored);
    expect(replaceRedactionProvenance(stored, PLACEHOLDER)).not.toContain(PLACEHOLDER);
  });

  it("round-trips a literal escape-byte pair byte-identical (legacy history untouched)", () => {
    const legacy = `a${REDACTION_PROVENANCE_ESCAPE}${REDACTION_PROVENANCE_ESCAPE}b`;
    expect(replaceRedactionProvenance(legacy, PLACEHOLDER)).toBe(legacy);
  });

  it("replaces a genuine mark after an escaped literal prefix (scanner rule)", () => {
    const genuine = markRedactionProvenance("***");
    const text = `${REDACTION_PROVENANCE_ESCAPE}${REDACTION_PROVENANCE_ESCAPE}${genuine}`;
    expect(replaceRedactionProvenance(text, PLACEHOLDER)).toBe(
      `${REDACTION_PROVENANCE_ESCAPE}${PLACEHOLDER}`,
    );
  });
});
