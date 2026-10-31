import type { Locator, Page } from "playwright";
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
// Short references stay atomic; qualified labels may wrap within their chip.
const LINK_FORMS = (
  [
    ["issue", "issue", "#123309", "then follow-up tracked in ", true],
    ["pull", "pull", "#3434", "then the fix is in ", true],
    ["repository-ref", "pull", "openclaw/openclaw#3434", "then see ", false],
    ["bare-url", "", "text.css", "then the owning rule lives at ", true],
    ["authored", "", "the sibling chip rule", "then see ", false],
  ] as const
).map(([id, kind, label, lead, bare]) => ({
  id,
  kind,
  label,
  lead,
  className: [bare && "markdown-bare-url", "markdown-github-link", kind && "markdown-github-item"]
    .filter(Boolean)
    .join(" "),
}));

const githubMarkup = LINK_FORMS.map(
  ({ className, kind, id, label, lead }) => `
    <div class="chat-text" id="column-${id}">Reproduce the failing run and read the notes
      first, ${lead}<a id="${id}" class="${className}" ${kind ? `data-github-kind="${kind}"` : ""} href="https://github.com/openclaw/openclaw"
      >${label}</a> before landing the fix.</div>`,
).join("");

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
    </div>${githubMarkup}`,
    themeMode,
  );
}

// One range probe owns the shared width sweep; each assertion keeps its own contract.
async function probeWrap(themeMode: "dark" | "light", container: WrapContainer) {
  return fixture.withPage(
    `${themeMode}-${container}`,
    wrapFixtureDocument(themeMode, container),
    (page) =>
      page.evaluate(
        ({ caseIds, githubIds, properties }) => {
          const resolve = (selector: string) => {
            const element = document.querySelector(selector);
            if (!(element instanceof HTMLElement)) {
              throw new Error(`Missing link fixture: ${selector}`);
            }
            return element;
          };
          const read = (selector: string) => {
            const css = getComputedStyle(resolve(selector));
            return Object.fromEntries(properties.map((property) => [property, css[property]]));
          };
          const glyph = (selector: string) => {
            const css = getComputedStyle(resolve(selector), "::before");
            return {
              fontSize: css.fontSize,
              height: css.height,
              maskImage: css.maskImage,
              paddingInlineStart: css.paddingInlineStart,
              position: css.position,
              width: css.width,
            };
          };
          const measure = (id: string, columnId: string, min: number, max: number) => {
            const element = resolve("#" + id),
              column = resolve("#" + columnId);
            const text = element.firstChild;
            if (!text) {
              throw new Error(`Missing label: ${id}`);
            }
            const range = document.createRange(),
              samples = [];
            for (let width = min; width <= max; width += 4) {
              column.style.width = `${width}px`;
              const rect = element.getBoundingClientRect(),
                first = element.getClientRects()[0]!;
              range.setStart(text, 0);
              range.setEnd(text, 1);
              const labelTop = range.getBoundingClientRect().top;
              range.selectNodeContents(element);
              const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
              samples.push({
                fragments: element.getClientRects().length,
                top: rect.top,
                width: rect.width,
                columnWidth: width,
                labelFragments: range.getClientRects().length,
                overflows: column.scrollWidth > column.clientWidth,
                labelStartsMarkLine: Math.abs(labelTop - first.top) < 2,
                markLineTop: Math.round(first.top),
                glyphToLabelGapPx: labelTop - rect.top,
                lineHeightPx: lineHeight,
                labelOverflowPx:
                  range.getBoundingClientRect().right - column.getBoundingClientRect().right,
                wrapped: rect.height > lineHeight * 1.3,
              });
            }
            return samples;
          };
          return {
            presentation: {
              chatGlyph: glyph("#from-text"),
              fromCode: read("#from-code > code"),
              fromText: read("#from-text"),
              panelFromCode: read("#panel-from-code > code"),
              panelFromText: read("#panel-from-text"),
              panelGlyph: glyph("#panel-from-text"),
              plainCode: read("#plain-code"),
            },
            samples: measure("wrap-chip", "column", 220, 900),
            long: measure("long-chip", "column", 220, 900),
            separation: Object.fromEntries(
              caseIds.map((id) => [id, measure(id, "column", 40, 320)] as const),
            ),
            github: Object.fromEntries(
              githubIds.map((id) => [id, measure(id, "column-" + id, 200, 900)] as const),
            ),
          };
        },
        {
          caseIds: SEPARATION_CASES.map((row) => row.id),
          githubIds: LINK_FORMS.map((row) => row.id),
          properties: CHIP_PROPERTIES,
        },
      ),
  );
}

const wrapping = new Map<string, Awaited<ReturnType<typeof probeWrap>>>();
const observation = (theme: string, container = "chat-text") =>
  wrapping.get(`${theme}/${container}`)!;
beforeAll(async () => {
  if (!fixture.available) {
    return;
  }
  for (const { themeMode, container } of WRAP_CASES) {
    wrapping.set(`${themeMode}/${container}`, await probeWrap(themeMode, container));
  }
});

fixture.describe("chat file link presentation", () => {
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
      expect(new Set(samples.map((sample) => Math.round(sample.top))).size).toBeGreaterThan(1);
      const split = samples.filter((sample) => sample.fragments !== 1);
      expect(split).toEqual([]);
    },
  );

  it.each(WRAP_CASES)(
    "keeps an unshortened file label inside the column in $container/$themeMode",
    ({ container, themeMode }) => {
      const { long, separation } = observation(themeMode, container);
      const overflowing = long.filter((sample) => sample.width > sample.columnWidth + 0.5);
      expect(overflowing).toEqual([]);
      expect(long.every((sample) => sample.fragments === 1)).toBe(true);
      const spilling = Object.values(separation)
        .flat()
        .filter((sample) => sample.labelOverflowPx > 0.5);
      expect(spilling).toEqual([]);
    },
  );

  // The outer inline-block rect cannot detect an internally stranded glyph.
  it.each(WRAP_CASES)(
    "keeps the glyph attached to the label's first character in $container/$themeMode",
    ({ container, themeMode }) => {
      const { separation } = observation(themeMode, container);
      for (const testCase of SEPARATION_CASES) {
        const caseSamples = separation[testCase.id]!;
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

function withFixture<T>(theme: "dark" | "light", run: (page: Page) => Promise<T>) {
  return fixture.withPage(theme, wrapFixtureDocument(theme, "chat-text"), run);
}

const interactionPaint = (chip: Locator) =>
  chip.evaluate((element) => ({
    background: getComputedStyle(element).backgroundColor,
    decoration: getComputedStyle(element).textDecorationLine,
  }));

fixture.describe("chat GitHub link presentation", () => {
  it.each(["light", "dark"] as const)(
    "keeps GitHub icons with their labels and reference chips contained at every column width in %s",
    async (themeMode) => {
      const samples = observation(themeMode).github;
      for (const { id, kind } of LINK_FORMS) {
        const collected = samples[id] ?? [];
        // Prove the sweep actually changes lines.
        expect(new Set(collected.map((sample) => sample.markLineTop)).size).toBeGreaterThan(1);
        const stranded = collected.filter((sample) => !sample.labelStartsMarkLine);
        expect({ id, stranded }).toEqual({ id, stranded: [] });
        if (kind) {
          // Qualified labels may exceed the column; short references remain unbroken.
          expect(
            collected.filter(
              (sample) =>
                sample.fragments !== 1 ||
                sample.overflows ||
                (id !== "repository-ref" && sample.labelFragments !== 1),
            ),
          ).toEqual([]);
        } else {
          // Non-item links fill their starting line instead of moving whole.
          expect({ id, splits: collected.some((sample) => sample.fragments > 1) }).toEqual({
            id,
            splits: true,
          });
        }
      }
    },
  );

  it.each(["ltr", "rtl"])(
    "wraps oversized qualified chips without clipping in %s",
    async (direction) => {
      await withFixture("dark", async (page) => {
        const geometry = await page.evaluate((dir) => {
          const column = document.querySelector<HTMLElement>("#column-repository-ref")!;
          const chip = document.querySelector<HTMLElement>("#repository-ref")!;
          column.style.width = "280px";
          column.style.fontSize = "28px";
          column.dir = dir;
          chip.textContent = "organization-with-a-long-name/repository-with-a-long-name#987654";
          const label = document.createRange();
          label.selectNodeContents(chip);
          return {
            width: column.clientWidth,
            scrollWidth: column.scrollWidth,
            chipWidth: chip.getBoundingClientRect().width,
            fragments: label.getClientRects().length,
          };
        }, direction);
        expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
        expect(geometry.chipWidth).toBeLessThanOrEqual(geometry.width);
        expect(geometry.fragments).toBeGreaterThan(1);
      });
    },
  );

  it.each(["light", "dark"] as const)(
    "paints distinct kind icons and visible hover and keyboard focus states in %s",
    async (themeMode) => {
      await withFixture(themeMode, async (page) => {
        const masks: string[] = [];
        for (const id of ["issue", "pull"]) {
          const chip = page.locator(`#${id}`);
          const idle = await chip.evaluate((element) => {
            const style = getComputedStyle(element);
            const icon = getComputedStyle(element, "::before");
            return {
              background: style.backgroundColor,
              decoration: style.textDecorationLine,
              iconColor: icon.backgroundColor,
              color: style.color,
              mask: icon.maskImage,
            };
          });
          expect(idle).toMatchObject({
            decoration: "none",
            iconColor: idle.color,
            mask: expect.stringContaining("data:image/svg+xml"),
          });
          masks.push(idle.mask);
          await chip.hover();
          const hover = await interactionPaint(chip);
          expect(hover.background).not.toBe(idle.background);
          expect(hover.decoration).toBe("underline");
          await page.mouse.move(0, 0);
          await page.keyboard.press("Tab");
          await chip.focus();
          expect(await chip.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
          expect(await interactionPaint(chip)).toEqual(hover);
          await chip.evaluate((element) => element.blur());
        }
        const genericMask = await page
          .locator("#authored")
          .evaluate((element) => getComputedStyle(element, "::before").maskImage);
        expect(new Set([...masks, genericMask]).size).toBe(3);
      });
    },
  );
});
