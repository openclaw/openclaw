import MarkdownIt from "markdown-it";
import { describe, expect, it } from "vitest";
import { prepareDictationFormatting } from "../../lib/dictation/formatting.ts";
import {
  placeReviewedDictation,
  selectDictationFormatting,
  type DictationFormattingTarget,
} from "./composer-dictation-formatting.ts";

const prepared = prepareDictationFormatting(
  "Shopping list bullet milk next item eggs",
  "explicit",
  {
    confirmedMarkers: [
      { start: 14, end: 20 },
      { start: 26, end: 35 },
    ],
  },
);
function target(): DictationFormattingTarget {
  return {
    identity: {},
    revision: 1,
    value: "",
    start: 0,
    end: 0,
    editable: true,
    focused: true,
    capabilities: { version: 1, revision: 1, formats: ["text/plain"], safeMultiline: true },
  };
}

describe("dictation destination preparation", () => {
  it("requires declared, current capabilities and keeps rich preparation separate from insertion", () => {
    const plain = target();
    expect(selectDictationFormatting(prepared, plain, plain)).toEqual({
      text: prepared.plainText,
      format: "text/plain",
      canApply: true,
    });
    expect(selectDictationFormatting(prepared, plain, undefined).canApply).toBe(false);
    const rich = {
      ...plain,
      capabilities: {
        ...plain.capabilities,
        formats: ["text/html", "text/plain"] as const,
        richTextProfile: "safe-blocks-v1" as const,
      },
    };
    expect(selectDictationFormatting(prepared, rich, rich)).toEqual({
      text: prepared.html,
      format: "text/html",
      canApply: false,
    });
    expect(selectDictationFormatting(prepared, rich, rich, true).canApply).toBe(true);
    const unsupported = { ...plain, capabilities: { ...plain.capabilities, formats: [] } };
    expect(selectDictationFormatting(prepared, unsupported, unsupported).canApply).toBe(false);
  });

  it("qualifies Markdown only for the whole draft and preserves original recovery at partial selections", () => {
    const markdown = {
      ...target(),
      value: "old draft",
      end: 9,
      capabilities: {
        ...target().capabilities,
        formats: ["text/markdown", "text/plain"] as const,
        markdownProfile: "commonmark-0.31.2-lists" as const,
      },
    };
    const selected = selectDictationFormatting(prepared, markdown, markdown);
    expect(selected.canApply).toBe(true);
    const draft = placeReviewedDictation(selected.text, {
      target: markdown,
      format: selected.format,
    }).value;
    const parsed = new MarkdownIt("commonmark", { html: false }).parse(draft, {});
    expect(parsed.filter((token) => token.type === "list_item_open")).toHaveLength(2);
    markdown.start = markdown.end;
    expect(selectDictationFormatting(prepared, markdown, markdown).canApply).toBe(false);
    expect(selectDictationFormatting(prepared, markdown, markdown, true).canApply).toBe(true);
    expect(placeReviewedDictation(" x ", { target: markdown, format: "text/plain" }).value).toBe(
      "old draft x ",
    );
  });

  it("refuses unsafe multiline or oversized targets without truncating the copy candidate", () => {
    const field = target();
    field.capabilities.safeMultiline = false;
    expect(selectDictationFormatting(prepared, field, field)).toMatchObject({
      text: prepared.plainText,
      canApply: false,
    });
    field.capabilities.safeMultiline = true;
    field.capabilities.maxLength = 5;
    expect(selectDictationFormatting(prepared, field, field).canApply).toBe(false);
    field.capabilities.maxLength = prepared.plainText.length;
    expect(selectDictationFormatting(prepared, field, field).canApply).toBe(true);
  });
});
