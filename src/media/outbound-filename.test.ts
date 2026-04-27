import { describe, expect, it } from "vitest";
import { stripFilenameControlChars } from "./outbound-filename.js";

const c = (code: number): string => String.fromCharCode(code);

describe("stripFilenameControlChars", () => {
  it("returns plain ASCII filenames unchanged", () => {
    expect(stripFilenameControlChars("report.pdf")).toBe("report.pdf");
    expect(stripFilenameControlChars("a.b-c_d.tar.gz")).toBe("a.b-c_d.tar.gz");
  });

  it("preserves non-ASCII letters and digits", () => {
    expect(stripFilenameControlChars("日本語_2025.pdf")).toBe("日本語_2025.pdf");
    expect(stripFilenameControlChars("отчет.docx")).toBe("отчет.docx");
    expect(stripFilenameControlChars("ملف.pdf")).toBe("ملف.pdf");
  });

  it.each([
    { name: "C0 control NUL", code: 0x0000 },
    { name: "C0 control TAB", code: 0x0009 },
    { name: "C0 control LF", code: 0x000a },
    { name: "C0 control CR", code: 0x000d },
    { name: "C0 control US", code: 0x001f },
    { name: "DEL", code: 0x007f },
    { name: "C1 control PAD", code: 0x0080 },
    { name: "C1 control APC", code: 0x009f },
    { name: "ZWSP", code: 0x200b },
    { name: "ZWNJ", code: 0x200c },
    { name: "ZWJ", code: 0x200d },
    { name: "LRE", code: 0x202a },
    { name: "RLE", code: 0x202b },
    { name: "PDF", code: 0x202c },
    { name: "LRO", code: 0x202d },
    { name: "RLO", code: 0x202e },
    { name: "LRI", code: 0x2066 },
    { name: "RLI", code: 0x2067 },
    { name: "FSI", code: 0x2068 },
    { name: "PDI", code: 0x2069 },
    { name: "BOM / ZWNBSP", code: 0xfeff },
  ] as const)("strips $name", ({ code }) => {
    const input = `pre${c(code)}post.txt`;
    expect(stripFilenameControlChars(input)).toBe("prepost.txt");
  });

  it("collapses bidi-spoofed extensions to their visible byte order", () => {
    // "report" + RLO + "gpj.exe" displays as "reportexe.jpg" on bidi-aware
    // clients but the underlying bytes end in .exe. After stripping RLO the
    // visible name matches the bytes.
    const input = `report${c(0x202e)}gpj.exe`;
    expect(stripFilenameControlChars(input)).toBe("reportgpj.exe");
  });

  it("returns an empty string when every character is stripped", () => {
    const allControl = `${c(0x0000)}${c(0x202e)}${c(0xfeff)}${c(0x200b)}`;
    expect(stripFilenameControlChars(allControl)).toBe("");
  });

  it("returns an empty string for empty input", () => {
    expect(stripFilenameControlChars("")).toBe("");
  });

  it("leaves printable Unicode outside the strip ranges intact", () => {
    // U+200E (LRM), U+200F (RLM), and U+202F (NARROW NO-BREAK SPACE) sit
    // just outside the strip ranges; preserve them so this helper does not
    // silently drift into broader filename normalization.
    const input = `a${c(0x200e)}b${c(0x200f)}c${c(0x202f)}d`;
    expect(stripFilenameControlChars(input)).toBe(input);
  });
});
