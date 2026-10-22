import { beforeAll, expect, it } from "vitest";
import { readStyles, styleDocument, styleFixture } from "./style-fixture.test-support.ts";

const fixture = styleFixture("chat-file-link-presentation-");

// File-link labels match except for glyph spacing owned by the outer anchor.
const CHIP_PROPERTIES = [
  "backgroundColor",
  "borderTopWidth",
  "borderTopStyle",
  "borderTopColor",
  "borderTopLeftRadius",
  "paddingTop",
  "paddingLeft",
  "fontFamily",
  "fontSize",
  "color",
] as const;

// Match styles/chat.ts: sidebar-markdown must load after chat/text.
function chatDocument(body: string, theme: "dark" | "light") {
  return styleDocument(
    readStyles(
      "styles/base",
      "styles/chat/startup-layout",
      "styles/chat/text",
      "styles/sidebar-markdown",
    ),
    body,
    theme === "light" ? 'data-theme="light" data-theme-mode="light"' : 'data-theme="dark"',
  );
}

const links = (prefix: string) => `<p>
  <a id="${prefix}from-text" class="markdown-file-link" data-file-kind="code" data-file-path="src/app.ts">app.ts</a>
  <a id="${prefix}from-code" class="markdown-file-link" data-file-kind="code" data-file-path="ui/app.ts"><code>app.ts</code></a>
  <code id="${prefix}plain-code">npm run dev</code></p>`;
const presentationMarkup = `<div class="chat-text">${links("")}</div>
  <article class="sidebar-markdown">${links("panel-")}</article>`;

// The reported list-edge reference includes a path the parser cannot shorten.
const LONG_CHIP_PATH = "packages/gateway-protocol/src/session-transport-envelope.ts";

// Unbroken labels need overflow-wrap; the glyph must stay with the first character.
function separationCase(id: string, filePath: string, line?: number, label = filePath) {
  return { id: `sep-${id}`, filePath, line, label };
}
const SEPARATION_CASES = [
  separationCase("short", "src/app.ts", undefined, "app.ts"),
  separationCase(
    "unbroken",
    "superlongfilenamewithoutanyslashesordashesorspacesatalljustonebigword.ts",
  ),
  separationCase("path-with-line", LONG_CHIP_PATH, 182),
  separationCase("enormous", `${"abcdefghij".repeat(24)}.ts`, 7),
  separationCase(
    "cjk",
    "~/repo/docs/spec.md",
    88,
    "文档/会话传输封装规范化适配器/协议架构第十七版/规范化器.ts",
  ),
];

// The panel does not inherit chat-text's wrapping and clips horizontal overflow.
const WRAP_CONTAINERS = ["chat-text", "sidebar-markdown"] as const;
type WrapContainer = (typeof WRAP_CONTAINERS)[number];

const WRAP_CASES = (["light", "dark"] as const).flatMap((themeMode) =>
  WRAP_CONTAINERS.map((container) => ({ container, themeMode })),
);

function wrapFixtureDocument(themeMode: "dark" | "light", container: WrapContainer): string {
  const separationLinks = SEPARATION_CASES.map(({ filePath, id, label, line }) => {
    const lineAttribute = line === undefined ? "" : ` data-file-line="${line}"`;
    const linkLabel = line === undefined ? label : `${label}:${line}`;
    return `<p><a id="${id}" class="markdown-file-link" data-file-kind="code"
        data-file-path="${filePath}"${lineAttribute}>${linkLabel}</a></p>`;
  }).join("\n");
  return chatDocument(
    `
    ${presentationMarkup}<div class="${container}" id="column">
      <ol><li>Reproduce the failing run, then read the harness entry point
        (<a id="wrap-chip" class="markdown-file-link" data-file-kind="code"
          data-file-path="test/harness.ts" data-file-line="182">harness.ts:182</a>)
        before landing the fix.</li></ol>
      <p><a id="long-chip" class="markdown-file-link" data-file-kind="code"
        data-file-path="${LONG_CHIP_PATH}">${LONG_CHIP_PATH}</a></p>
      ${separationLinks}
    </div>`,
    themeMode,
  );
}

// Sweep widths so changing fonts/prose cannot silently miss the wrap boundary.
async function probeWrap(themeMode: "dark" | "light", container: WrapContainer) {
  return fixture.withPage(
    `${themeMode}-${container}-wrap`,
    wrapFixtureDocument(themeMode, container),
    async (page) => {
      return await page.evaluate(
        ({ caseIds, properties }) => {
          const resolve = (selector: string) => {
            const element = document.querySelector(selector);
            if (!(element instanceof HTMLElement)) {
              throw new Error(`Missing wrap fixture element for ${selector}`);
            }
            return element;
          };
          const read = (selector: string) => {
            const computed = getComputedStyle(resolve(selector));
            return Object.fromEntries(properties.map((property) => [property, computed[property]]));
          };
          const glyph = (selector: string) => {
            const computed = getComputedStyle(resolve(selector), "::before");
            return {
              fontSize: computed.fontSize,
              height: computed.height,
              maskImage: computed.maskImage,
              paddingInlineStart: computed.paddingInlineStart,
              position: computed.position,
              width: computed.width,
            };
          };
          const presentation = {
            chatGlyph: glyph("#from-text"),
            fromCode: read("#from-code > code"),
            fromText: read("#from-text"),
            panelFromCode: read("#panel-from-code > code"),
            panelFromText: read("#panel-from-text"),
            panelGlyph: glyph("#panel-from-text"),
            plainCode: read("#plain-code"),
          };

          const column = resolve("#column");
          const chip = resolve("#wrap-chip");
          const longChip = resolve("#long-chip");
          const separationChips = caseIds.map((caseId) => ({
            caseId,
            element: resolve(`#${caseId}`),
          }));
          const samples = [];
          const separation = [];
          for (let columnWidth = 220; columnWidth <= 900; columnWidth += 4) {
            column.style.width = `${columnWidth}px`;
            samples.push({
              chipLineCount: chip.getClientRects().length,
              chipTop: chip.getBoundingClientRect().top,
              columnWidth,
              longChipLineCount: longChip.getClientRects().length,
              longChipWidth: longChip.getBoundingClientRect().width,
            });
          }
          // Narrower widths force even short basenames to wrap.
          for (let columnWidth = 40; columnWidth <= 320; columnWidth += 4) {
            column.style.width = `${columnWidth}px`;
            const columnRight = column.getBoundingClientRect().right;
            for (const { caseId, element } of separationChips) {
              const elementTop = element.getBoundingClientRect().top;
              const labelTextNode = element.firstChild;
              if (!labelTextNode) {
                throw new Error(`Separation fixture ${caseId} has no label text node`);
              }
              const firstCharacterRange = document.createRange();
              firstCharacterRange.setStart(labelTextNode, 0);
              firstCharacterRange.setEnd(labelTextNode, 1);
              const firstCharacterTop = firstCharacterRange.getBoundingClientRect().top;
              const labelRange = document.createRange();
              labelRange.selectNodeContents(labelTextNode);
              const lineHeightPx = Number.parseFloat(getComputedStyle(element).lineHeight);
              separation.push({
                caseId,
                columnWidth,
                glyphToLabelGapPx: firstCharacterTop - elementTop,
                lineHeightPx,
                labelOverflowPx: labelRange.getBoundingClientRect().right - columnRight,
                wrapped: element.getBoundingClientRect().height > lineHeightPx * 1.3,
              });
            }
          }
          return { samples, separation, presentation };
        },
        { caseIds: SEPARATION_CASES.map((testCase) => testCase.id), properties: CHIP_PROPERTIES },
      );
    },
  );
}

fixture.describe("chat file link presentation", () => {
  const wrapping = new Map<string, Awaited<ReturnType<typeof probeWrap>>>();
  const observation = (theme: string, container = "chat-text") =>
    wrapping.get(`${theme}/${container}`)!;

  beforeAll(async () => {
    // The assertion families consume the same read-only observations.
    for (const { themeMode, container } of WRAP_CASES) {
      wrapping.set(`${themeMode}/${container}`, await probeWrap(themeMode, container));
    }
  });

  it.each(["light", "dark"] as const)(
    "renders code-authored and text-authored file links identically in %s",
    (themeMode) => {
      const { fromCode, fromText } = observation(themeMode).presentation;
      // The anchor reserves glyph space; its nested code label must not reserve it again.
      expect(fromCode).toEqual({ ...fromText, paddingLeft: "0px" });
    },
  );

  it.each(["light", "dark"] as const)(
    "leaves the chip on code spans that are not file links in %s",
    (themeMode) => {
      const { fromText, plainCode } = observation(themeMode).presentation;
      expect(plainCode.backgroundColor).not.toBe(fromText.backgroundColor);
      expect(plainCode.borderTopWidth).not.toBe("0px");
      expect(fromText).toMatchObject({
        borderTopWidth: "0px",
        backgroundColor: "rgba(0, 0, 0, 0)",
      });
    },
  );

  it.each(["light", "dark"] as const)(
    "gives the Chat Detail Panel the same file-link treatment in %s",
    (themeMode) => {
      const probed = observation(themeMode).presentation;
      expect([probed.panelFromText, probed.panelFromCode, probed.panelGlyph]).toEqual([
        probed.fromText,
        probed.fromCode,
        probed.chatGlyph,
      ]);
      expect(probed.panelGlyph.maskImage).toContain("svg");
    },
  );

  it.each(["light", "dark"] as const)(
    "gives every masked file glyph a concrete font-sized paint box in %s",
    (themeMode) => {
      const { chatGlyph, panelGlyph } = observation(themeMode).presentation;
      for (const glyph of [chatGlyph, panelGlyph]) {
        expect(glyph).toMatchObject({
          position: "absolute",
          width: glyph.fontSize,
          height: glyph.fontSize,
          paddingInlineStart: "0px",
        });
      }
    },
  );

  it.each(WRAP_CASES)(
    "wraps a file link as one unit at every column width in $container/$themeMode",
    ({ container, themeMode }) => {
      const { samples } = observation(themeMode, container);
      // Prove the sweep actually changes lines.
      expect(new Set(samples.map((sample) => Math.round(sample.chipTop))).size).toBeGreaterThan(1);
      const split = samples.filter((sample) => sample.chipLineCount !== 1);
      expect(split).toEqual([]);
    },
  );

  it.each(WRAP_CASES)(
    "keeps an unshortened file label inside the column in $container/$themeMode",
    ({ container, themeMode }) => {
      const { samples, separation } = observation(themeMode, container);
      const overflowing = samples.filter(
        (sample) => sample.longChipWidth > sample.columnWidth + 0.5,
      );
      expect(overflowing).toEqual([]);
      expect(samples.every((sample) => sample.longChipLineCount === 1)).toBe(true);
      const spilling = separation.filter((sample) => sample.labelOverflowPx > 0.5);
      expect(spilling).toEqual([]);
    },
  );

  // The outer inline-block rect cannot detect an internally stranded glyph.
  it.each(WRAP_CASES)(
    "keeps the glyph attached to the label's first character in $container/$themeMode",
    ({ container, themeMode }) => {
      const { separation } = observation(themeMode, container);
      for (const testCase of SEPARATION_CASES) {
        const caseSamples = separation.filter((sample) => sample.caseId === testCase.id);
        expect(caseSamples.length).toBeGreaterThan(0);
        // Each fixture must wrap; otherwise the attachment check is vacuous.
        expect(caseSamples.some((sample) => sample.wrapped)).toBe(true);
        const separated = caseSamples.filter(
          (sample) => sample.glyphToLabelGapPx > sample.lineHeightPx / 2,
        );
        expect(separated).toEqual([]);
      }
    },
  );
});
