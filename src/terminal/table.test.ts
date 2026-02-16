import { describe, expect, it } from "vitest";
import { visibleWidth } from "./ansi.js";
import { wrapNoteMessage } from "./note.js";
import { renderTable } from "./table.js";

describe("renderTable", () => {
  it("prefers shrinking flex columns to avoid wrapping non-flex labels", () => {
    const out = renderTable({
      width: 40,
      columns: [
        { key: "Item", header: "Item", minWidth: 10 },
        { key: "Value", header: "Value", flex: true, minWidth: 24 },
      ],
      rows: [{ Item: "Dashboard", Value: "http://127.0.0.1:18789/" }],
    });

    expect(out).toContain("Dashboard");
    expect(out).toMatch(/│ Dashboard\s+│/);
  });

  it("expands flex columns to fill available width", () => {
    const width = 60;
    const out = renderTable({
      width,
      columns: [
        { key: "Item", header: "Item", minWidth: 10 },
        { key: "Value", header: "Value", flex: true, minWidth: 24 },
      ],
      rows: [{ Item: "OS", Value: "macos 26.2 (arm64)" }],
    });

    const firstLine = out.trimEnd().split("\n")[0] ?? "";
    expect(visibleWidth(firstLine)).toBe(width);
  });

  it("wraps ANSI-colored cells without corrupting escape sequences", () => {
    const out = renderTable({
      width: 36,
      columns: [
        { key: "K", header: "K", minWidth: 3 },
        { key: "V", header: "V", flex: true, minWidth: 10 },
      ],
      rows: [
        {
          K: "X",
          V: `\x1b[33m${"a".repeat(120)}\x1b[0m`,
        },
      ],
    });

    const ESC = "\u001b";
    for (let i = 0; i < out.length; i += 1) {
      if (out[i] !== ESC) {
        continue;
      }

      // SGR: ESC [ ... m
      if (out[i + 1] === "[") {
        let j = i + 2;
        while (j < out.length) {
          const ch = out[j];
          if (ch === "m") {
            break;
          }
          if (ch && ch >= "0" && ch <= "9") {
            j += 1;
            continue;
          }
          if (ch === ";") {
            j += 1;
            continue;
          }
          break;
        }
        expect(out[j]).toBe("m");
        i = j;
        continue;
      }

      // OSC-8: ESC ] 8 ; ; ... ST (ST = ESC \)
      if (out[i + 1] === "]" && out.slice(i + 2, i + 5) === "8;;") {
        const st = out.indexOf(`${ESC}\\`, i + 5);
        expect(st).toBeGreaterThanOrEqual(0);
        i = st + 1;
        continue;
      }

      throw new Error(`Unexpected escape sequence at index ${i}`);
    }
  });

  it("resets ANSI styling on wrapped lines", () => {
    const reset = "\x1b[0m";
    const out = renderTable({
      width: 24,
      columns: [
        { key: "K", header: "K", minWidth: 3 },
        { key: "V", header: "V", flex: true, minWidth: 10 },
      ],
      rows: [
        {
          K: "X",
          V: `\x1b[31m${"a".repeat(80)}${reset}`,
        },
      ],
    });

    const lines = out.split("\n").filter((line) => line.includes("a"));
    for (const line of lines) {
      const resetIndex = line.lastIndexOf(reset);
      const lastSep = line.lastIndexOf("│");
      expect(resetIndex).toBeGreaterThan(-1);
      expect(lastSep).toBeGreaterThan(resetIndex);
    }
  });

  it("respects explicit newlines in cell values", () => {
    const out = renderTable({
      width: 48,
      columns: [
        { key: "A", header: "A", minWidth: 6 },
        { key: "B", header: "B", minWidth: 10, flex: true },
      ],
      rows: [{ A: "row", B: "line1\nline2" }],
    });

    const lines = out.trimEnd().split("\n");
    const line1Index = lines.findIndex((line) => line.includes("line1"));
    const line2Index = lines.findIndex((line) => line.includes("line2"));
    expect(line1Index).toBeGreaterThan(-1);
    expect(line2Index).toBe(line1Index + 1);
  });
});

describe("wrapNoteMessage", () => {
  it("preserves long filesystem paths without inserting spaces/newlines", () => {
    const input =
      "/Users/user/Documents/Github/impact-signals-pipeline/with/really/long/segments/file.txt";
    const wrapped = wrapNoteMessage(input, { maxWidth: 22, columns: 80 });

    expect(wrapped).toBe(input);
  });

  it("preserves long urls without inserting spaces/newlines", () => {
    const input =
      "https://example.com/this/is/a/very/long/url/segment/that/should/not/be/split/for-copy";
    const wrapped = wrapNoteMessage(input, { maxWidth: 24, columns: 80 });

    expect(wrapped).toBe(input);
  });

  it("preserves long file-like underscore tokens for copy safety", () => {
    const input = "administrators_authorized_keys_with_extra_suffix";
    const wrapped = wrapNoteMessage(input, { maxWidth: 14, columns: 80 });

    expect(wrapped).toBe(input);
  });

  it("still chunks generic long opaque tokens to avoid pathological line width", () => {
    const input = "x".repeat(70);
    const wrapped = wrapNoteMessage(input, { maxWidth: 20, columns: 80 });

    expect(wrapped).toContain("\n");
    expect(wrapped.replace(/\n/g, "")).toBe(input);
  });

  it("wraps bullet lines while preserving bullet indentation", () => {
    const input = "- one two three four five six seven eight nine ten";
    const wrapped = wrapNoteMessage(input, { maxWidth: 18, columns: 80 });
    const lines = wrapped.split("\n");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]?.startsWith("- ")).toBe(true);
    expect(lines.slice(1).every((line) => line.startsWith("  "))).toBe(true);
  });

  it("preserves long Windows paths without inserting spaces/newlines", () => {
    // No spaces: wrapNoteMessage splits on whitespace, so a "Program Files" style path would wrap.
    const input = "C:\\\\State\\\\OpenClaw\\\\bin\\\\openclaw.exe";
    const wrapped = wrapNoteMessage(input, { maxWidth: 10, columns: 80 });
    expect(wrapped).toBe(input);
  });

  it("preserves UNC paths without inserting spaces/newlines", () => {
    const input = "\\\\\\\\server\\\\share\\\\some\\\\really\\\\long\\\\path\\\\file.txt";
    const wrapped = wrapNoteMessage(input, { maxWidth: 12, columns: 80 });
    expect(wrapped).toBe(input);
  });
});
