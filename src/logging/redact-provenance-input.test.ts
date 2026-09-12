// Marker bytes in input must never stand in for proof that masking already ran
// (#142821 review): only a whole value that is nothing but one mask this encoder
// produced may pass through, and every other value is masked like any other secret.
import {
  REDACTION_PROVENANCE_END,
  REDACTION_PROVENANCE_START,
  markRedactionProvenance,
} from "@openclaw/normalization-core/redaction-provenance";
import { describe, expect, it } from "vitest";
import { redactSensitiveFieldValueWithConfig, redactSensitiveText } from "./redact.js";
import { registerSecretValueForRedaction } from "./secret-redaction-registry.js";

/** What an earlier revision of the provenance encoding persisted. */
const LEGACY_DELIMITER_TEXT = "⟦openclaw:redacted⟧";

function redactPassword(value: string): string {
  return redactSensitiveFieldValueWithConfig("password", value, {});
}

describe("marker bytes in input never exempt a value from masking (#142821)", () => {
  it("masks a sensitive field that carries a trailing marker opener", () => {
    const value = `hunter2${REDACTION_PROVENANCE_START}`;
    const redacted = redactPassword(value);
    expect(redacted).toBe("***");
  });

  it("masks a sensitive field that carries a legacy delimiter", () => {
    expect(redactPassword(`hunter2${LEGACY_DELIMITER_TEXT}`)).toBe("***");
  });

  it("masks a sensitive field that spells a complete literal mark", () => {
    expect(redactPassword(`${REDACTION_PROVENANCE_START}secret${REDACTION_PROVENANCE_END}`)).toBe(
      "***",
    );
  });

  it("passes a real marker mask through unchanged", () => {
    const placeholder = markRedactionProvenance("***");
    const hint = markRedactionProvenance("sk-abc…0xyz");
    expect(redactPassword(placeholder)).toBe(placeholder);
    expect(redactPassword(hint)).toBe(hint);
  });

  it("masks a registered secret whose own bytes carry the marker", () => {
    const registered = `registered${REDACTION_PROVENANCE_START}`;
    registerSecretValueForRedaction(registered);
    const redacted = redactSensitiveText(`value ${registered} end`, { mode: "tools" });
    expect(redacted).not.toContain("registered");
  });
});
