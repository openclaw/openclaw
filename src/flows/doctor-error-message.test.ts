// Regression tests for doctor error-message sanitization, focused on the C1
// control range (U+0080-U+009F) added on top of the existing C0/DEL stripping.
import { describe, expect, it } from "vitest";
import { scrubDoctorErrorMessage } from "./doctor-error-message.js";

const CSI = String.fromCharCode(0x9b); // C1 CSI introducer, alt ANSI escape prefix
const NUL = String.fromCharCode(0x00);
const BEL = String.fromCharCode(0x07);
const DEL = String.fromCharCode(0x7f);

describe("scrubDoctorErrorMessage", () => {
  it("strips the CSI introducer U+009B while keeping surrounding text", () => {
    const input = new Error(`boot ${CSI}31mfailed${CSI}0m`);
    expect(scrubDoctorErrorMessage(input)).toBe("boot 31mfailed0m");
  });

  it("removes the full C1 range 0x80-0x9f", () => {
    let raw = "";
    for (let code = 0x80; code <= 0x9f; code += 1) {
      raw += String.fromCharCode(code);
    }
    expect(scrubDoctorErrorMessage(new Error(`a${raw}b`))).toBe("ab");
  });

  it("preserves ordinary printable Unicode above the C1 range", () => {
    // U+00A0 (NBSP) and beyond must survive; only 0x80-0x9f are stripped.
    const input = new Error("café ☕ 日本語 \u{1f680}");
    expect(scrubDoctorErrorMessage(input)).toBe("café ☕ 日本語 \u{1f680}");
  });

  it("still strips C0 controls and DEL", () => {
    const input = new Error(`x${NUL}${BEL}${DEL}y`);
    expect(scrubDoctorErrorMessage(input)).toBe("xy");
  });
});
