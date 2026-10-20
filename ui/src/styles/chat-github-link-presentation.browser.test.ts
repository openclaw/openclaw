import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { readStyles, styleDocument, styleFixture } from "./style-fixture.test-support.ts";

const fixture = styleFixture("chat-github-link-presentation-");

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

function fixtureDocument(themeMode: "dark" | "light"): string {
  const themeAttributes =
    themeMode === "light" ? `data-theme="light" data-theme-mode="light"` : `data-theme="dark"`;
  const columns = LINK_FORMS.map(
    ({ className, kind, id, label, lead }) => `
      <div class="chat-text" id="column-${id}">Reproduce the failing run and read the notes
        first, ${lead}<a id="${id}" class="${className}" ${kind ? `data-github-kind="${kind}"` : ""} href="https://github.com/openclaw/openclaw"
        >${label}</a> before landing the fix.</div>`,
  ).join("");
  return styleDocument(
    readStyles("styles/base", "styles/chat/startup-layout", "styles/chat/text"),
    columns,
    themeAttributes,
  );
}

type WrapSample = {
  readonly fragments: number;
  readonly labelFragments: number;
  readonly overflows: boolean;
  readonly labelStartsMarkLine: boolean;
  readonly markLineTop: number;
};

// Sweep widths so font/prose changes cannot silently miss the wrap boundary.
async function probeWrap(
  themeMode: "dark" | "light",
): Promise<Record<string, readonly WrapSample[]>> {
  return withFixture(themeMode, async (page) => {
    return await page.evaluate(
      (ids: readonly string[]) => {
        const resolve = (selector: string) => {
          const element = document.querySelector(selector);
          if (!(element instanceof HTMLElement)) {
            throw new Error(`Missing GitHub link fixture element for ${selector}`);
          }
          return element;
        };
        const samples: Record<string, WrapSample[]> = {};
        for (const id of ids) {
          const column = resolve(`#column-${id}`);
          const link = resolve(`#${id}`);
          const collected: WrapSample[] = [];
          for (let columnWidth = 200; columnWidth <= 900; columnWidth += 4) {
            column.style.width = `${columnWidth}px`;
            // The mark and first label character must start on the same line.
            const linkStart = link.getClientRects()[0];
            const labelRange = document.createRange();
            const labelText = link.firstChild;
            if (!labelText || !linkStart) {
              throw new Error(`Missing label geometry for ${id}`);
            }
            labelRange.setStart(labelText, 0);
            labelRange.setEnd(labelText, 1);
            const labelStart = labelRange.getBoundingClientRect();
            labelRange.selectNodeContents(link);
            collected.push({
              fragments: link.getClientRects().length,
              labelFragments: labelRange.getClientRects().length,
              overflows: column.scrollWidth > column.clientWidth,
              labelStartsMarkLine: Math.abs(labelStart.top - linkStart.top) < 2,
              markLineTop: Math.round(linkStart.top),
            });
          }
          samples[id] = collected;
        }
        return samples;
      },
      LINK_FORMS.map((form) => form.id),
    );
  });
}

async function withFixture<T>(
  theme: "dark" | "light",
  run: (page: Page) => Promise<T>,
): Promise<T> {
  return fixture.withPage(theme, fixtureDocument(theme), run);
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
      const samples = await probeWrap(themeMode);
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

  it("keeps GitHub links breaking across lines instead of moving whole", async () => {
    const samples = await probeWrap("dark");
    // Non-item links still fill the line they start on rather than moving whole.
    for (const id of ["bare-url", "authored"]) {
      const collected = samples[id] ?? [];
      expect({ id, splits: collected.some((sample) => sample.fragments > 1) }).toEqual({
        id,
        splits: true,
      });
    }
  });

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
