import MarkdownIt from "markdown-it";
import { parseFragment } from "parse5";
import { describe, expect, it } from "vitest";
import {
  prepareDictationFormatting,
  renderDictationDocument,
  validateDictationDocument,
  type DictationDocument,
} from "./formatting.ts";

const markdown = new MarkdownIt("commonmark", { html: false, linkify: false });
const range = (start: number, end: number) => ({ start, end });
const textRun = (start: number, end: number) => ({ type: "text", source: range(start, end) });
function sourceDocument(text: string, blocks: unknown[], consumedMarkers: unknown[] = []) {
  return {
    version: 1,
    mode: consumedMarkers.length ? "explicit" : "preserve",
    source: { id: "capture-1", revision: 7, text },
    protectedRanges: [],
    blocks,
    consumedMarkers,
    confirmedMarkers: [],
  };
}
function parsedText(input: string): string[] {
  return markdown
    .parse(input, {})
    .filter((token) => token.type === "inline")
    .map((token) =>
      (token.children ?? [])
        .map((child) =>
          child.type === "hardbreak" || child.type === "softbreak" ? "\n" : child.content,
        )
        .join(""),
    );
}

describe("dictation semantic formatting", () => {
  it("preserves existing transcript bytes and escapes literal Markdown independently", () => {
    const input =
      "    # not a heading\n* [name](https://example.test) _text_ <script> &copy; `code`\n\nשלום 👩🏽‍💻 e\u0301";
    const result = prepareDictationFormatting(input);
    expect(result.status).toBe("preserved");
    expect(result.plainText).toBe(input);
    expect(markdown.parse(result.markdown, {}).map((token) => token.type)).not.toContain(
      "heading_open",
    );
    expect(markdown.parse(result.markdown, {}).map((token) => token.type)).not.toContain(
      "code_block",
    );
    expect(parsedText(result.markdown)).toEqual([
      "    # not a heading\n* [name](https://example.test) _text_ <script> &copy; `code`",
      "שלום 👩🏽‍💻 e\u0301",
    ]);
    expect(result.document?.source).toEqual({
      id: "local-final-transcript",
      revision: 0,
      text: input,
    });
  });

  it("prepares the shopping-list fixture once from source spans", () => {
    const result = prepareDictationFormatting(
      "Shopping list bullet milk next item eggs next item rice",
      "explicit",
      {
        sourceId: "mic-9",
        sourceRevision: 2,
        confirmedMarkers: [range(14, 20), range(26, 35), range(41, 50)],
      },
    );
    expect(result.status).toBe("formatted");
    expect(result.plainText).toBe("Shopping list\n\n- milk\n- eggs\n- rice");
    expect(result.counts).toEqual({ blocks: 2, items: 3, depth: 1 });
    expect(parsedText(result.markdown)).toEqual(["Shopping list", "milk", "eggs", "rice"]);
    expect(
      markdown.parse(result.markdown, {}).filter((token) => token.type === "list_item_open"),
    ).toHaveLength(3);
    expect(result.document?.consumedMarkers.map((marker) => marker.reason)).toEqual([
      "bullet",
      "next-item",
      "next-item",
    ]);
    expect(result.document?.source.id).toBe("mic-9");
  });

  it("retains negation, quantities, paragraph boundaries and hard breaks", () => {
    const result = prepareDictationFormatting(
      "Do not renew 2.5 licenses. new paragraph. Opening line. new line. Closing line",
      "explicit",
      { confirmedMarkers: [range(27, 41), range(56, 65)] },
    );
    expect(result.plainText).toBe("Do not renew 2.5 licenses.\n\nOpening line.\nClosing line");
    expect(parsedText(result.markdown)).toEqual([
      "Do not renew 2.5 licenses.",
      "Opening line.\nClosing line",
    ]);
    expect(result.html).toBe(
      "<p>Do not renew 2.5 licenses.</p><p>Opening line.<br>Closing line</p>",
    );
    const ambiguous = prepareDictationFormatting(
      "Do not enable auto renew bullet review the invoice",
      "explicit",
    );
    expect(ambiguous.plainText).toBe(ambiguous.originalText);
    expect(ambiguous.status).not.toBe("formatted");
  });

  it("does not let CommonMark renumber skipped or repeated explicit steps", () => {
    const result = prepareDictationFormatting(
      "step three check power step seven restart step seven verify step twelve finish",
      "explicit",
      { confirmedMarkers: [range(0, 10), range(23, 33), range(42, 52), range(60, 71)] },
    );
    expect(result.status).toBe("formatted");
    expect(result.plainText).toBe("3. check power\n7. restart\n7. verify\n12. finish");
    const renderedOrdinals: number[] = [];
    let next = 0;
    for (const token of markdown.parse(result.markdown, {})) {
      if (token.type === "ordered_list_open") {
        next = Number(token.attrGet("start") ?? 1);
      } else if (token.type === "list_item_open") {
        renderedOrdinals.push(next++);
      }
    }
    expect(renderedOrdinals).toEqual([3, 7, 7, 12]);
    expect(result.html).toContain('<li value="7">verify</li>');
  });

  it("retains nested order and line breaks within the declared depth", () => {
    const input =
      "start list bullet parent nested list bullet child nested list step three leaf. new line. detail end list end list next item sibling end list";
    const result = prepareDictationFormatting(input, "explicit", {
      confirmedMarkers: [
        range(0, 10),
        range(11, 17),
        range(25, 36),
        range(37, 43),
        range(50, 61),
        range(62, 72),
        range(79, 88),
        range(96, 104),
        range(105, 113),
        range(114, 123),
        range(132, 140),
      ],
    });
    expect(result.status).toBe("formatted");
    expect(result.counts).toEqual({ blocks: 3, items: 4, depth: 3 });
    expect(parsedText(result.markdown)).toEqual(["parent", "child", "leaf.\ndetail", "sibling"]);
    expect(
      markdown.parse(result.markdown, {}).filter((token) => token.type === "list_item_open"),
    ).toHaveLength(4);
  });

  it.each([
    "The phrase new paragraph appears in the instructions",
    "The words bullet and next item are examples",
    "Read the new paragraph before continuing",
    "A bullet train leaves at nine",
    "Bullet points help readers scan. Bullet lists group related items.",
    "I need new paragraph spacing",
    "Our new paragraph starts with a date",
    "We discussed new paragraph indentation yesterday",
    "Opening paragraph new paragraph closing paragraph",
    "step one point five calibrate",
    "step one zero calibrate",
    "step one ten calibrate",
    'She said "new paragraph" and "bullet milk"',
    "Use `bullet milk next item eggs` literally",
    "```text\nnew paragraph\nbullet milk\n```",
    "First check power second restart the app",
    "https://example.test/new-paragraph?q=bullet",
  ])("retains literal or uncertain marker discussion: %s", (input) => {
    const result = prepareDictationFormatting(input, "explicit");
    expect(result.plainText).toBe(input);
    expect(result.status).not.toBe("formatted");
  });

  it("never consumes explicitly protected markers or applies English to another locale", () => {
    const input = "Opening new paragraph closing";
    expect(
      prepareDictationFormatting(input, "explicit", { protectedRanges: [range(8, 21)] }).plainText,
    ).toBe(input);
    expect(prepareDictationFormatting(input, "explicit", { locale: "de-DE" })).toMatchObject({
      status: "needs-review",
      plainText: input,
      reason: "unsupported-command-locale",
    });
    expect(prepareDictationFormatting("Opening new paragraph", "explicit")).toMatchObject({
      status: "needs-review",
      plainText: "Opening new paragraph",
    });
  });

  it("formats an undelimited paragraph only after exact user-selected marker confirmation", () => {
    const input = "Opening paragraph new paragraph closing paragraph";
    const review = prepareDictationFormatting(input, "explicit");
    expect(review).toMatchObject({ status: "needs-review", plainText: input });
    expect(review.candidates).toEqual([{ source: range(18, 31), reason: "paragraph-break" }]);
    const result = prepareDictationFormatting(input, "explicit", {
      confirmedMarkers: [range(18, 31)],
    });
    expect(result.status).toBe("formatted");
    expect(result.plainText).toBe("Opening paragraph\n\nclosing paragraph");
    expect(parsedText(result.markdown)).toEqual(["Opening paragraph", "closing paragraph"]);
    expect(result.document?.confirmedMarkers).toEqual([range(18, 31)]);
    expect(result.candidates).toEqual([]);
    expect(validateDictationDocument({ ...result.document!, confirmedMarkers: [] }).ok).toBe(false);
    expect(
      prepareDictationFormatting("Opening\nnew paragraph\nclosing", "explicit").plainText,
    ).toBe("Opening\nnew paragraph\nclosing");
    expect(
      prepareDictationFormatting("Opening\nnew paragraph\nclosing", "explicit", {
        confirmedMarkers: [range(8, 21)],
      }).plainText,
    ).toBe("Opening\n\nclosing");
  });

  it("rejects stale, quoted, protected, duplicate and malformed confirmations", () => {
    const input = "Opening paragraph new paragraph closing paragraph";
    for (const confirmedMarkers of [
      [range(17, 31)],
      [range(18, 32)],
      [range(18, 31), range(18, 31)],
    ]) {
      expect(prepareDictationFormatting(input, "explicit", { confirmedMarkers })).toMatchObject({
        status: "raw-fallback",
        plainText: input,
      });
    }
    expect(
      prepareDictationFormatting(input, "explicit", {
        confirmedMarkers: [range(18, 31)],
        protectedRanges: [range(18, 31)],
      }).status,
    ).toBe("raw-fallback");
    const quoted = 'Opening "new paragraph" closing';
    expect(
      prepareDictationFormatting(quoted, "explicit", { confirmedMarkers: [range(9, 22)] }).status,
    ).toBe("raw-fallback");
    expect(
      prepareDictationFormatting("The phrase new paragraph appears", "explicit").candidates,
    ).toEqual([{ source: range(11, 24), reason: "paragraph-break" }]);
    expect(
      prepareDictationFormatting("Opening new paragraph closing ".repeat(21), "explicit"),
    ).toMatchObject({
      status: "needs-review",
      reason: "too-many-ambiguous-commands",
      candidates: [],
    });
  });

  it("confirms the reported bullet-points phrase without keyword intent guesses", () => {
    const input = "Shopping list bullet points to discuss next item budget";
    const review = prepareDictationFormatting(input, "explicit");
    expect(review).toMatchObject({ status: "needs-review", plainText: input });
    expect(review.candidates).toEqual([
      { source: range(14, 20), reason: "bullet" },
      { source: range(39, 48), reason: "next-item" },
    ]);
    const result = prepareDictationFormatting(input, "explicit", {
      confirmedMarkers: [range(14, 20), range(39, 48)],
    });
    expect(result.status).toBe("formatted");
    expect(result.plainText).toBe("Shopping list\n\n- points to discuss\n- budget");
    expect(parsedText(result.markdown)).toEqual(["Shopping list", "points to discuss", "budget"]);
    expect(result.candidates).toEqual([]);
    expect(validateDictationDocument({ ...result.document!, confirmedMarkers: [] })).toMatchObject({
      ok: false,
      reason: "ambiguous-marker-consumption",
    });
    expect(
      validateDictationDocument({ ...result.document!, consumedMarkers: [] }),
    ).toMatchObject({ ok: false, reason: "unused-marker-confirmation" });
  });

  it("keeps unselected list words literal and rejects an orphan continuation", () => {
    const input = "Shopping list bullet points to discuss next item budget";
    const partial = prepareDictationFormatting(input, "explicit", {
      confirmedMarkers: [range(14, 20)],
    });
    expect(partial.status).toBe("formatted");
    expect(partial.plainText).toBe("Shopping list\n\n- points to discuss next item budget");
    expect(partial.candidates).toEqual([{ source: range(39, 48), reason: "next-item" }]);
    expect(
      prepareDictationFormatting(input, "explicit", { confirmedMarkers: [range(39, 48)] }),
    ).toMatchObject({ status: "needs-review", reason: "ambiguous-structure", plainText: input });
  });

  it("offers every recognized marker while leaving its intent undecided", () => {
    const input =
      "new paragraph new line bullet next item start list nested list end list step twenty";
    const result = prepareDictationFormatting(input, "explicit");
    expect(result).toMatchObject({ status: "needs-review", plainText: input });
    expect(result.candidates).toEqual([
      { source: range(0, 13), reason: "paragraph-break" },
      { source: range(14, 22), reason: "line-break" },
      { source: range(23, 29), reason: "bullet" },
      { source: range(30, 39), reason: "next-item" },
      { source: range(40, 50), reason: "list-start" },
      { source: range(51, 62), reason: "nested-list" },
      { source: range(63, 71), reason: "list-end" },
      { source: range(72, 83), reason: "numbered-item", ordinal: 20 },
    ]);
  });

  it.each([
    ['"bullet milk"', range(1, 7)],
    ["`bullet milk`", range(1, 7)],
    ["https://example.com/bullet", range(20, 26)],
  ] as const)("does not offer or consume a protected list marker: %s", (input, source) => {
    expect(prepareDictationFormatting(input, "explicit").candidates).toEqual([]);
    expect(
      prepareDictationFormatting(input, "explicit", { confirmedMarkers: [source] }),
    ).toMatchObject({
      status: "raw-fallback",
      reason: "invalid-marker-confirmation",
      plainText: input,
    });
  });

  it("preserves the complete original on overflow even with a selected prefix", () => {
    const input = "bullet item ".repeat(21);
    expect(
      prepareDictationFormatting(input, "explicit", { confirmedMarkers: [range(0, 6)] }),
    ).toMatchObject({
      status: "needs-review",
      reason: "too-many-ambiguous-commands",
      plainText: input,
      originalText: input,
      candidates: [],
    });
  });

  it.each(["\n\n", "\r\n\r\n", "\r\r"])(
    "retains original paragraph structure around confirmed commands: %j",
    (separator) => {
      const input = `First${separator}Second new line third${separator}Fourth`;
      const start = 12 + separator.length;
      const result = prepareDictationFormatting(input, "explicit", {
        confirmedMarkers: [range(start, start + 8)],
      });
      expect(result.status).toBe("formatted");
      expect(result.plainText).toBe("First\n\nSecond\nthird\n\nFourth");
      expect(parsedText(result.markdown)).toEqual(["First", "Second\nthird", "Fourth"]);
      expect(result.counts).toEqual({ blocks: 3, items: 0, depth: 0 });
    },
  );

  it("produces only allowlisted nodes and numeric list attributes", () => {
    const input =
      'bullet <script>alert(1)</script> next item <img src="https://example.test" onerror="x"> next item [x](javascript:evil)';
    const result = prepareDictationFormatting(input, "explicit", {
      confirmedMarkers: [range(0, 6), range(33, 42), range(88, 97)],
    });
    expect(result.status).toBe("formatted");
    const fragment = parseFragment(result.html);
    const queue = [...fragment.childNodes];
    while (queue.length) {
      const node = queue.pop()!;
      if ("tagName" in node) {
        expect(["p", "br", "ul", "ol", "li"]).toContain(node.tagName);
        for (const attr of node.attrs) {
          expect(["start", "value"]).toContain(attr.name);
          expect(attr.value).toMatch(/^\d{1,9}$/);
        }
        queue.push(...node.childNodes);
      }
    }
    expect(parsedText(result.markdown)).toEqual([
      "<script>alert(1)</script>",
      '<img src="https://example.test" onerror="x">',
      "[x](javascript:evil)",
    ]);
  });
});

describe("dictation document trust boundary", () => {
  it("rejects lost, duplicated, reordered and split lexical content", () => {
    const make = (runs: unknown[]) => sourceDocument("one two", [{ type: "paragraph", runs }]);
    expect(validateDictationDocument(make([textRun(0, 7)])).ok).toBe(true);
    const faithfulSplit = validateDictationDocument(make([textRun(0, 4), textRun(4, 7)]));
    expect(faithfulSplit.ok).toBe(true);
    if (faithfulSplit.ok) {
      expect(parsedText(renderDictationDocument(faithfulSplit.document).markdown)).toEqual([
        "one two",
      ]);
    }
    for (const runs of [
      [textRun(0, 3)],
      [textRun(0, 3), textRun(4, 7)],
      [textRun(0, 3), textRun(0, 3), textRun(4, 7)],
      [textRun(4, 7), textRun(0, 3)],
      [textRun(0, 1), textRun(1, 7)],
    ]) {
      expect(validateDictationDocument(make(runs)).ok).toBe(false);
    }
  });

  it("preserves every protected byte including edge whitespace and multiline code", () => {
    const input = "  customer_id  ";
    const prepared = prepareDictationFormatting(input, "preserve", {
      protectedRanges: [range(0, input.length)],
    });
    expect(parsedText(prepared.markdown)).toEqual([input]);
    const omitted = {
      ...prepared.document!,
      blocks: [{ type: "paragraph", runs: [textRun(2, 13)] }],
    };
    expect(validateDictationDocument(omitted).ok).toBe(false);
    const code = "```\n  a\n\n  b  \n```";
    expect(parsedText(prepareDictationFormatting(code).markdown)).toEqual([code]);
    const listed = prepareDictationFormatting("bullet `a\nb` next item c", "explicit", {
      confirmedMarkers: [range(0, 6), range(13, 22)],
    });
    expect(listed.plainText).toBe("- `a\nb`\n- c");
    expect(parsedText(listed.markdown)).toEqual(["`a\nb`", "c"]);
    const nested = prepareDictationFormatting(
      "bullet parent nested list bullet `a\nb` end list end list",
      "explicit",
      {
        confirmedMarkers: [range(0, 6), range(14, 25), range(26, 32), range(39, 47), range(48, 56)],
      },
    );
    expect(nested.plainText).toBe("- parent\n  - `a\nb`");
    const protectedDraft = "  customer_id  new paragraph closing";
    const confirmed = prepareDictationFormatting(protectedDraft, "explicit", {
      protectedRanges: [range(0, 15)],
      confirmedMarkers: [range(15, 28)],
    });
    expect(parsedText(confirmed.markdown)).toEqual(["  customer_id  ", "closing"]);
  });

  it("requires every paragraph boundary to have source structure or an owned command", () => {
    const blocks = [
      { type: "paragraph", runs: [textRun(0, 3)] },
      { type: "paragraph", runs: [textRun(4, 7)] },
    ];
    for (const mode of ["preserve", "explicit"]) {
      expect(
        validateDictationDocument({ ...sourceDocument("one two", blocks), mode }),
      ).toMatchObject({ ok: false, reason: "unapproved-paragraph-boundary" });
    }
    expect(
      validateDictationDocument(
        sourceDocument("one\n\ntwo", [blocks[0], { type: "paragraph", runs: [textRun(5, 8)] }]),
      ).ok,
    ).toBe(true);
  });

  it("rejects merged paragraphs across adjacent runs and retains protected spans", () => {
    const value = (runs: unknown[]) => ({
      ...sourceDocument("one\n\ntwo", [{ type: "paragraph", runs }]),
      mode: "explicit",
    });
    for (const runs of [[textRun(0, 8)], [textRun(0, 4), textRun(4, 8)]]) {
      expect(validateDictationDocument(value(runs))).toMatchObject({
        ok: false,
        reason: "merged-source-paragraphs",
      });
    }
    expect(
      validateDictationDocument({ ...value([textRun(0, 8)]), protectedRanges: [range(0, 8)] }).ok,
    ).toBe(true);
    expect(prepareDictationFormatting("one\r\ntwo").counts.blocks).toBe(1);
  });

  it("rejects forged marker reasons, unknown nodes and unowned markers", () => {
    const forged = sourceDocument(
      "not milk",
      [
        {
          type: "list",
          ordered: false,
          items: [{ marker: range(0, 3), runs: [textRun(4, 8)], children: [] }],
        },
      ],
      [{ source: range(0, 3), reason: "bullet" }],
    );
    expect(validateDictationDocument(forged)).toMatchObject({
      ok: false,
      reason: "invalid-marker-reason",
    });
    expect(
      validateDictationDocument(sourceDocument("milk", [{ type: "script", runs: [textRun(0, 4)] }]))
        .ok,
    ).toBe(false);
    const valid = prepareDictationFormatting("bullet milk", "explicit", {
      confirmedMarkers: [range(0, 6)],
    }).document!;
    expect(validateDictationDocument({ ...valid, version: 2 }).ok).toBe(false);
    expect(
      validateDictationDocument({
        ...valid,
        blocks: [{ type: "paragraph", runs: [textRun(0, 11)] }],
      }).ok,
    ).toBe(false);
    expect(
      validateDictationDocument({
        ...valid,
        consumedMarkers: [{ source: range(0, 6), reason: "line-break" }],
      }).ok,
    ).toBe(false);
  });

  it("rejects malformed Unicode/source metadata while retaining the original draft", () => {
    const input = "👩🏽‍💻 new paragraph e\u0301";
    for (const protectedRanges of [
      [range(-1, 2)],
      [range(0, 1)],
      [range(0, 2)],
      [range(0, 7), range(1, 2)],
    ]) {
      expect(prepareDictationFormatting(input, "explicit", { protectedRanges })).toMatchObject({
        status: "raw-fallback",
        plainText: input,
      });
    }
    expect(prepareDictationFormatting(input, "explicit", { sourceRevision: -1 }).status).toBe(
      "raw-fallback",
    );
    expect(prepareDictationFormatting("bad\ud800", "explicit").status).toBe("raw-fallback");
  });

  it("rejects cycles, oversized collections and depth beyond the declared bound", () => {
    const valid = prepareDictationFormatting("bullet milk", "explicit", {
      confirmedMarkers: [range(0, 6)],
    }).document!;
    const item = { marker: range(0, 6), runs: [textRun(7, 11)], children: [] as unknown[] };
    const cycle = { type: "list", ordered: false, items: [item] };
    item.children.push(cycle);
    expect(validateDictationDocument({ ...valid, blocks: [cycle] }).ok).toBe(false);
    expect(
      prepareDictationFormatting("bullet milk" + " next item eggs".repeat(100), "explicit").status,
    ).toBe("needs-review");
    expect(
      prepareDictationFormatting(
        "bullet a nested list bullet b nested list bullet c nested list bullet d",
        "explicit",
        {
          confirmedMarkers: [
            range(0, 6),
            range(9, 20),
            range(21, 27),
            range(30, 41),
            range(42, 48),
            range(51, 62),
            range(63, 69),
          ],
        },
      ),
    ).toMatchObject({ status: "needs-review", reason: "document-limit" });
    expect(prepareDictationFormatting("é".repeat(16_385), "explicit")).toMatchObject({
      status: "raw-fallback",
      reason: "text-limit",
      markdown: "",
      html: "",
    });
    expect(
      prepareDictationFormatting(Array.from({ length: 100 }, () => "paragraph").join("\n\n")).counts
        .blocks,
    ).toBe(100);
    expect(
      prepareDictationFormatting(Array.from({ length: 101 }, () => "paragraph").join("\n\n"))
        .status,
    ).toBe("raw-fallback");
  });

  it("rejects bounded malformed range mutations without accepting partial source coverage", () => {
    let seed = 17;
    const baseline: DictationDocument = prepareDictationFormatting("negation").document!;
    for (let iteration = 0; iteration < 128; iteration++) {
      seed = (seed * 16_807) % 2_147_483_647;
      const end = (seed % 30) - 10;
      if (end === 8) {
        continue;
      }
      const candidate = { ...baseline, blocks: [{ type: "paragraph", runs: [textRun(0, end)] }] };
      expect(validateDictationDocument(candidate).ok).toBe(false);
    }
  });
});
