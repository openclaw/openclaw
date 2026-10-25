import {
  getCapabilities,
  getOsc8LinkAtColumn,
  setCapabilities,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { normalizeTestText } from "../../../test/helpers/normalize-text.js";
import { BtwInlineMessage } from "./btw-inline-message.js";

function expectUrlLink(lines: string[], url: string) {
  const line = lines.find((entry) => normalizeTestText(entry).includes(url));
  expect(line).toBeDefined();
  const visible = normalizeTestText(line!);
  const start = visibleWidth(visible.slice(0, visible.indexOf(url)));
  for (let column = start; column < start + url.length; column++) {
    expect(getOsc8LinkAtColumn(line!, column)).toBe(url);
  }
  expect(getOsc8LinkAtColumn(line!, start - 1)).toBeUndefined();
  expect(getOsc8LinkAtColumn(line!, start + url.length)).toBeUndefined();
}

describe("btw inline message", () => {
  it("renders the BTW question, answer, and dismiss hint inline", () => {
    const message = new BtwInlineMessage({ question: "what is 17 * 19?", text: "323" });
    expect(message.render(80)).toEqual([
      "",
      " BTW: what is 17 * 19?                                                          ",
      "",
      "323                                                                             ",
      " Press Enter or Esc to dismiss                                                  ",
    ]);
  });

  it.each([true, false])(
    "sanitizes questions and Markdown updates with native hyperlinks=%s",
    (hyperlinks) => {
      const capabilities = getCapabilities();
      setCapabilities({ ...capabilities, hyperlinks });
      try {
        const url = "https://example.test/tui/btw?copy=caf%C3%A9";
        const message = new BtwInlineMessage({
          question: "first \x1b[3Jquestion\r\nمرحبا\tשלום",
          text: `\x1b]52;c;clipboard\x07**first café**\nsecond body ${url}`,
        });

        function check(visible: string[]) {
          const lines = message.render(140);
          const raw = lines.join("\n");
          for (const text of visible) {
            expect(normalizeTestText(raw)).toContain(text);
          }
          for (const attack of ["\x1b[3J", "\x1b]52;", "\u009b3J", "\u009d0;"]) {
            expect(raw).not.toContain(attack);
          }
          expect(lines[1]).not.toMatch(/[\r\n\t]/u);
          expectUrlLink(lines, url);
          return normalizeTestText(raw);
        }
        check(["BTW: \u2067first question مرحبا שלום\u2069", "first café", "second body"]);

        message.setResult({
          question: "next \u009b3Jquestion\r\nשלום\tمرحبا",
          text: `\u009d0;title\u009c**next 東京** ${url}`,
        });

        const rendered = check(["BTW: \u2067next question שלום مرحبا\u2069", "next 東京"]);
        expect(rendered).not.toMatch(/first question|first café/u);
      } finally {
        setCapabilities(capabilities);
      }
    },
  );

  it("passes sanitized RTL source through Markdown exactly once", () => {
    const message = new BtwInlineMessage({
      question: "structure proof",
      text: "\u202e# مرحبا\u202c\n\n\u200f> שלום\n\n\u2066- عنصر\u2069",
    });

    const lines = message.render(100);
    const normalized = normalizeTestText(lines.join("\n")).replace(/[\u2067\u2069]/gu, "");
    expect(normalized).toContain("مرحبا");
    expect(normalized).not.toContain("# مرحبا");
    expect(normalized).toContain("│ שלום");
    expect(normalized).toContain("- عنصر");
    for (const line of lines.filter((entry) => /[\u0590-\u08ff]/u.test(entry))) {
      expect(line.match(/[\u2067\u2069]/gu)).toEqual(["\u2067", "\u2069"]);
    }
  });

  it.each([false, true])("sanitizes errors with an empty fallback=%s", (empty) => {
    const questionAttack = "\x1b]0;question-title\x07";
    const text = empty ? " \x1b]0;hidden title\x07 " : "\u009b3Jretry **plain** safely café";
    const question = `why ${questionAttack}failed?\r\nمرحبا\tשלום`;
    const raw = new BtwInlineMessage({ question, text, isError: true }).render(100).join("\n");
    const rendered = normalizeTestText(raw);
    expect(rendered).toContain("BTW: \u2067why failed? مرحبا שלום\u2069");
    expect(rendered).toContain(empty ? "(no output)" : "retry **plain** safely café");
    expect(raw).not.toContain(questionAttack);
    expect(raw).not.toContain(empty ? "\x1b]0;hidden title\x07" : "\u009b3Jretry");
  });
});
