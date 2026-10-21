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

function fixtureDocument(themeMode: "dark" | "light"): string {
  const links = (prefix: string) => `<p>
    <a id="${prefix}from-text" class="markdown-file-link" data-file-kind="code" data-file-path="src/app.ts">app.ts</a>
    <a id="${prefix}from-code" class="markdown-file-link" data-file-kind="code" data-file-path="ui/app.ts"><code>app.ts</code></a>
    <code id="${prefix}plain-code">npm run dev</code></p>`;
  return chatDocument(
    `
    <div class="chat-text">${links("")}</div>
    <article class="sidebar-markdown">${links("panel-")}</article>`,
    themeMode,
  );
}

// The reported list-edge reference includes a path the parser cannot shorten.
const LONG_CHIP_PATH = "packages/gateway-protocol/src/session-transport-envelope.ts";

// Unbroken labels need overflow-wrap; the glyph must stay with the first character.
const SEPARATION_CASES = [
  { filePath: "src/app.ts", id: "sep-short", label: "app.ts", line: undefined },
  {
    filePath: "superlongfilenamewithoutanyslashesordashesorspacesatalljustonebigword.ts",
    id: "sep-unbroken",
    label: "superlongfilenamewithoutanyslashesordashesorspacesatalljustonebigword.ts",
    line: undefined,
  },
  { filePath: LONG_CHIP_PATH, id: "sep-path-with-line", label: LONG_CHIP_PATH, line: 182 },
  {
    filePath: `${"abcdefghij".repeat(24)}.ts`,
    id: "sep-enormous",
    label: `${"abcdefghij".repeat(24)}.ts`,
    line: 7,
  },
  {
    filePath: "~/repo/docs/spec.md",
    id: "sep-cjk",
    label: "文档/会话传输封装规范化适配器/协议架构第十七版/规范化器.ts",
    line: 88,
  },
] as const;

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
    <div class="${container}" id="column">
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

type SeparationSample = {
  readonly caseId: (typeof SEPARATION_CASES)[number]["id"];
  readonly columnWidth: number;
  readonly glyphToLabelGapPx: number;
  readonly lineHeightPx: number;
  readonly labelOverflowPx: number;
  readonly wrapped: boolean;
};

type WrapSample = {
  readonly chipLineCount: number;
  readonly chipTop: number;
  readonly columnWidth: number;
  readonly longChipLineCount: number;
  readonly longChipWidth: number;
};

// Sweep widths so changing fonts/prose cannot silently miss the wrap boundary.
async function probeWrap(
  themeMode: "dark" | "light",
  container: WrapContainer,
): Promise<{
  readonly samples: readonly WrapSample[];
  readonly separation: readonly SeparationSample[];
}> {
  return fixture.withPage(
    `${themeMode}-${container}-wrap`,
    wrapFixtureDocument(themeMode, container),
    async (page) => {
      return await page.evaluate(
        (caseIds) => {
          const resolve = (selector: string) => {
            const element = document.querySelector(selector);
            if (!(element instanceof HTMLElement)) {
              throw new Error(`Missing wrap fixture element for ${selector}`);
            }
            return element;
          };
          const column = resolve("#column");
          const chip = resolve("#wrap-chip");
          const longChip = resolve("#long-chip");
          const separationChips = caseIds.map((caseId) => ({
            caseId,
            element: resolve(`#${caseId}`),
          }));
          const samples: WrapSample[] = [];
          const separation: SeparationSample[] = [];
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
          return { samples, separation };
        },
        SEPARATION_CASES.map((testCase) => testCase.id),
      );
    },
  );
}

async function probe(themeMode: "dark" | "light") {
  return fixture.withPage(themeMode, fixtureDocument(themeMode), async (page) => {
    return await page.evaluate((properties) => {
      const resolve = (selector: string) => {
        const element = document.querySelector(selector);
        if (!element) {
          throw new Error(`Missing presentation fixture element for ${selector}`);
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
      return {
        chatGlyph: glyph("#from-text"),
        fromCode: read("#from-code > code"),
        fromText: read("#from-text"),
        panelFromCode: read("#panel-from-code > code"),
        panelFromText: read("#panel-from-text"),
        panelGlyph: glyph("#panel-from-text"),
        plainCode: read("#plain-code"),
      };
    }, CHIP_PROPERTIES);
  });
}

fixture.describe("chat file link presentation", () => {
  let presentation: Record<"dark" | "light", Awaited<ReturnType<typeof probe>>>;
  let wrapping: Record<
    "dark" | "light",
    Record<WrapContainer, Awaited<ReturnType<typeof probeWrap>>>
  >;

  beforeAll(async () => {
    // The assertion families consume the same read-only observations.
    presentation = { light: await probe("light"), dark: await probe("dark") };
    wrapping = {
      light: {
        "chat-text": await probeWrap("light", "chat-text"),
        "sidebar-markdown": await probeWrap("light", "sidebar-markdown"),
      },
      dark: {
        "chat-text": await probeWrap("dark", "chat-text"),
        "sidebar-markdown": await probeWrap("dark", "sidebar-markdown"),
      },
    };
  });

  it.each(["light", "dark"] as const)(
    "renders code-authored and text-authored file links identically in %s",
    (themeMode) => {
      const { fromCode, fromText } = presentation[themeMode];
      // The anchor reserves glyph space; its nested code label must not reserve it again.
      expect(fromCode).toEqual({ ...fromText, paddingLeft: "0px" });
    },
  );

  it.each(["light", "dark"] as const)(
    "leaves the chip on code spans that are not file links in %s",
    (themeMode) => {
      const { fromText, plainCode } = presentation[themeMode];
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
      const probed = presentation[themeMode];
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
      const { chatGlyph, panelGlyph } = presentation[themeMode];
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
      const { samples } = wrapping[themeMode][container];
      // Prove the sweep actually changes lines.
      expect(new Set(samples.map((sample) => Math.round(sample.chipTop))).size).toBeGreaterThan(1);
      const split = samples.filter((sample) => sample.chipLineCount !== 1);
      expect(split).toEqual([]);
    },
  );

  it.each(WRAP_CASES)(
    "keeps an unshortened file label inside the column in $container/$themeMode",
    ({ container, themeMode }) => {
      const { samples, separation } = wrapping[themeMode][container];
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
      const { separation } = wrapping[themeMode][container];
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
