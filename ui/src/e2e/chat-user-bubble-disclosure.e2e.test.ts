import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import {
  captureUiProofEnabled,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();

async function expectCenteredToggle(bubble: Locator) {
  const { above, below } = await bubble.evaluate((element) => {
    const content = element.querySelector(".chat-message-disclosure__content")!;
    const toggle = element.querySelector(".chat-message-disclosure__toggle")!;
    const surface = element.classList.contains("chat-bubble--with-images")
      ? content.parentElement!
      : element;
    const button = toggle.getBoundingClientRect();
    return {
      above: button.top - content.getBoundingClientRect().bottom,
      below:
        surface.getBoundingClientRect().bottom -
        Number.parseFloat(getComputedStyle(surface).borderBottomWidth) -
        button.bottom,
    };
  });
  expect(Math.abs(above - below)).toBeLessThanOrEqual(1);
}

async function expectReadableLastLine(content: Locator) {
  const geometry = await content.evaluate((element) => {
    const paragraph = element.querySelector("p, li")!;
    const style = getComputedStyle(paragraph);
    const lineHeight = Number.parseFloat(style.lineHeight);
    const clip = element.getBoundingClientRect();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const lines: DOMRect[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim()) {
        continue;
      }
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (rect.width > 0 && !lines.some((line) => line.top === rect.top)) {
          lines.push(rect);
        }
      }
    }
    const visible = lines.filter((line) => line.top < clip.bottom);
    const last = visible.at(-1)!;
    const leading = lines[0]!.top - paragraph.getBoundingClientRect().top;
    const lineTop = last.top - leading;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d")!;
    context.font = style.font;
    const metrics = context.measureText("x");
    const baseline = last.top + metrics.fontBoundingBoxAscent;
    return {
      visibleLines: visible.length,
      fraction: (clip.bottom - lineTop) / lineHeight,
      baselineVisible: clip.bottom > baseline,
      upperRow: Math.floor(lineTop + lineHeight / 2 - clip.top) - 1,
      lowerRow: Math.floor(baseline - clip.top - 1),
    };
  });
  expect(geometry.visibleLines).toBe(5);
  expect(geometry.fraction).toBeGreaterThanOrEqual(0.66);
  expect(geometry.fraction).toBeLessThanOrEqual(0.75);
  expect(geometry.baselineVisible, "the x-height fits above the cut").toBe(true);

  const masked = await content.screenshot({ animations: "disabled" });
  await content.evaluate((element) => ((element as HTMLElement).style.maskImage = "none"));
  let unmasked: Buffer;
  try {
    unmasked = await content.screenshot({ animations: "disabled" });
  } finally {
    await content.evaluate((element) =>
      (element as HTMLElement).style.removeProperty("mask-image"),
    );
  }
  const rows = await content.evaluate(
    async (_, { images, sampleRows }) => {
      const sampleImage = async (source: string) => {
        const image = new Image();
        image.src = source;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        const sampleRow = (y: number) => {
          const { data } = context.getImageData(0, y, image.width, 1);
          const values: number[] = [];
          for (let x = 0; x < image.width; x++) {
            values.push(data.subarray(x * 4, x * 4 + 3).reduce((sum, value) => sum + value, 0));
          }
          return Math.max(...values) - Math.min(...values);
        };
        return { upper: sampleRow(sampleRows.upper), lower: sampleRow(sampleRows.lower) };
      };
      return Promise.all([sampleImage(images.masked), sampleImage(images.unmasked)]);
    },
    {
      images: {
        masked: `data:image/png;base64,${masked.toString("base64")}`,
        unmasked: `data:image/png;base64,${unmasked.toString("base64")}`,
      },
      sampleRows: { upper: geometry.upperRow, lower: geometry.lowerRow },
    },
  );
  const upperAlpha = rows[0].upper / rows[1].upper;
  const lowerAlpha = rows[0].lower / rows[1].lower;
  expect(upperAlpha, "the upper half remains legible").toBeGreaterThan(0.65);
  expect(upperAlpha, "the fade reaches the upper half instead of ending abruptly").toBeLessThan(
    0.9,
  );
  expect(lowerAlpha, "the bottom of the line visibly fades").toBeLessThan(upperAlpha - 0.2);
}

suite.define(() => {
  it("keeps seven short lines fully visible", async () => {
    const text = [
      "please re-review these:",
      "#127818",
      "#127826",
      "#127844",
      "#127881",
      "",
      "rerun the same session we had for these",
    ].join("\n");
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    await installMockGateway(page, {
      historyMessages: [{ role: "user", content: [{ type: "text", text }], timestamp: 1 }],
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const bubble = page.locator(".chat-group.user .chat-bubble");
      await bubble.waitFor({ state: "visible", timeout: 10_000 });
      if (captureUiProofEnabled) {
        await bubble.screenshot({
          path: path.join(suite.artifactDir, "user-bubble-clamp", "short-message.png"),
        });
      }

      expect(await bubble.getByRole("button", { name: "Show more" }).count()).toBe(0);
      expect(await bubble.locator(".chat-message-disclosure").count()).toBe(0);
      const bubbleText = await bubble.textContent();
      for (const line of text.split("\n").filter(Boolean)) {
        expect(bubbleText).toContain(line);
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it.each(
    (["light", "dark"] as const).flatMap((theme) =>
      [1440, 390].flatMap((width) =>
        [false, true].flatMap((withImage) =>
          ["continuous", "paragraphs", "list"].map((layout) => ({
            theme,
            width,
            withImage,
            layout,
          })),
        ),
      ),
    ),
  )(
    "clamps and centers a long prompt in $theme at $width px (image: $withImage, layout: $layout)",
    async ({ theme, width, withImage, layout }) => {
      const prose =
        (layout === "paragraphs" ? "Opening context.\nReview the sample notes.\n\n" : "") +
        `${"This long prompt stays mounted while its preview is clamped. ".repeat(22)}Final prompt tail.`.slice(
          0,
          1_300,
        );
      const text =
        layout === "list"
          ? Array.from(
              { length: 18 },
              (_, index) =>
                `- Review sample item ${index + 1}: keep the project notes clear and explain the next useful step.`,
            ).join("\n")
          : prose;
      const context = await suite.newBrowserContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 844, width },
        colorScheme: theme,
      });
      const page = await context.newPage();
      await installMockGateway(page, {
        historyMessages: [
          {
            role: "user",
            content: [
              ...(withImage
                ? [
                    {
                      type: "image",
                      url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='32'%3E%3Crect width='64' height='32' fill='teal'/%3E%3C/svg%3E",
                    },
                  ]
                : []),
              { type: "text", text },
            ],
            timestamp: 1,
          },
          // Source exceeds the threshold, but all five rendered lines fit the full preview.
          {
            role: "user",
            content: Array.from(
              { length: 5 },
              (_, index) => `[Short link ${index + 1}](https://example.com/${"a".repeat(300)})`,
            ).join("\n"),
            timestamp: 2,
          },
        ],
      });

      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        const bubbles = page.locator(".chat-group.user .chat-bubble");
        const bubble = bubbles.first();
        await bubble.waitFor({ state: "visible", timeout: 10_000 });
        const content = bubble.locator(".chat-message-disclosure__content");
        const toggle = bubble.getByRole("button", { name: "Show more" });

        await page.evaluate(() => document.fonts.ready);
        await expectCenteredToggle(bubble);
        await expectReadableLastLine(content);
        expect(await content.evaluate((element) => getComputedStyle(element).maskImage)).not.toBe(
          "none",
        );
        const fitting = bubbles.nth(1);
        await fitting.locator(".chat-message-disclosure__toggle").waitFor({ state: "hidden" });
        expect(
          await fitting
            .locator(".chat-message-disclosure__content")
            .evaluate((element) => getComputedStyle(element).maskImage),
        ).toBe("none");
        expect(await toggle.getAttribute("aria-expanded")).toBe("false");
        expect(
          await content
            .locator(layout === "list" ? ".chat-text li" : ".chat-text p")
            .allTextContents(),
        ).toEqual(
          layout === "list" ? text.split("\n").map((item) => item.slice(2)) : text.split("\n\n"),
        );
        const collapsedHeight = await content.evaluate((element) => element.clientHeight);
        expect(
          await content.evaluate((element) => element.scrollHeight > element.clientHeight),
        ).toBe(true);
        if (captureUiProofEnabled) {
          await bubble.screenshot({
            path: path.join(
              suite.artifactDir,
              "user-bubble-clamp",
              `${theme}-${width}-${withImage ? "image" : "text"}-${layout}-collapsed.png`,
            ),
          });
        }

        await toggle.click();
        const collapse = bubble.getByRole("button", { name: "Show less" });
        expect(await collapse.getAttribute("aria-expanded")).toBe("true");
        await expectCenteredToggle(bubble);
        expect(await content.evaluate((element) => getComputedStyle(element).maskImage)).toBe(
          "none",
        );
        expect(await content.evaluate((element) => element.clientHeight)).toBeGreaterThan(
          collapsedHeight,
        );
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );

  it("remeasures the fifth line after viewport and text reflow", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1440, height: 844 },
      colorScheme: "light",
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      historyMessages: [
        {
          role: "user",
          content:
            "Keep the project notes clear enough for someone reading the conversation later. ".repeat(
              3,
            ) +
            "\n\n" +
            "The remaining sample notes stay available after expansion. ".repeat(24),
          timestamp: 1,
        },
      ],
    });
    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const content = page.locator(".chat-message-disclosure__content");
      await content.waitFor();
      await page.evaluate(() => document.fonts.ready);
      await expectReadableLastLine(content);
      const desktopHeight = await content.evaluate((element) => element.clientHeight);
      await page.setViewportSize({ width: 390, height: 844 });
      await expect
        .poll(() => content.evaluate((element) => element.clientHeight))
        .not.toBe(desktopHeight);
      await expectReadableLastLine(content);
      await page.setViewportSize({ width: 1440, height: 844 });
      await expect
        .poll(() => content.evaluate((element) => element.clientHeight))
        .toBe(desktopHeight);
      await expectReadableLastLine(content);
      await content.locator(".chat-text").evaluate((element) => {
        (element as HTMLElement).style.fontSize = "18px";
      });
      await expect
        .poll(() => content.evaluate((element) => element.clientHeight))
        .not.toBe(desktopHeight);
      await expectReadableLastLine(content);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it.each(["paragraphs", "escaped HTML", "native summary"])(
    "measures visible lines when authored details with %s close and reopen",
    async (body) => {
      const context = await suite.newBrowserContext({ viewport: { width: 1440, height: 844 } });
      const page = await context.newPage();
      try {
        await installMockGateway(page, {
          historyMessages: [
            {
              role: "user",
              content:
                (body === "native summary"
                  ? "<details>\n\n"
                  : "<details><summary>Hidden reference</summary>\n\n") +
                (body === "escaped HTML"
                  ? `<div>${"Hidden row with reference text. ".repeat(20)}</div>\n`
                  : "Hidden row with reference text.\n".repeat(20)) +
                "\n</details>\n\n" +
                "Visible project notes continue here and explain the next useful step. ".repeat(28),
              timestamp: 1,
            },
          ],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const content = page.locator(".chat-message-disclosure__content");
        const details = content.locator("details");
        const summary = details.locator("summary");
        await details.waitFor();
        await page.evaluate(() => document.fonts.ready);
        const expectFourthProseLineCut = async (paragraph: Locator) => {
          const fraction = () =>
            paragraph.evaluate((element) => {
              const range = document.createRange();
              const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
              const lines: DOMRect[] = [];
              for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                if (!node.textContent?.trim() || node.parentElement?.closest("summary")) {
                  continue;
                }
                range.selectNodeContents(node);
                for (const rect of range.getClientRects()) {
                  if (rect.width > 0 && !lines.some((line) => line.top === rect.top)) {
                    lines.push(rect);
                  }
                }
              }
              const fourthLine = lines[3]!;
              const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
              const lineTop = fourthLine.top - Math.floor((lineHeight - fourthLine.height) / 2);
              const bottom = element
                .closest(".chat-message-disclosure__content")!
                .getBoundingClientRect().bottom;
              return (bottom - lineTop) / lineHeight;
            });
          // The visible summary owns the first preview line; prose supplies the next four.
          await expect.poll(fraction).toSatisfy((value: number) => value >= 0.66 && value <= 0.75);
        };
        const outside = content.locator(".chat-text > p");
        const toggleDetails = () =>
          body === "native summary"
            ? details.click({ position: { x: 30, y: 10 } })
            : summary.click();
        await expectFourthProseLineCut(outside);
        await toggleDetails();
        await expectFourthProseLineCut(details);
        await toggleDetails();
        await expectFourthProseLineCut(outside);
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );

  it("keeps densely spaced block art within five preview rows", async () => {
    const context = await suite.newBrowserContext({ viewport: { width: 1440, height: 844 } });
    const page = await context.newPage();
    try {
      await installMockGateway(page, {
        historyMessages: [
          {
            role: "user",
            content:
              "```\n" +
              Array.from({ length: 24 }, () => "█▀▄ ".repeat(20)).join("\n") +
              "\n```\n\n" +
              "Follow the sample notes. ".repeat(60),
            timestamp: 1,
          },
        ],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      const content = page.locator(".chat-message-disclosure__content");
      await content.waitFor();
      await page.evaluate(() => document.fonts.ready);
      const visibleRows = await content.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element.querySelector("code.markdown-block-art")!);
        const bottom = element.getBoundingClientRect().bottom;
        return [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.top < bottom)
          .length;
      });
      expect(visibleRows).toBe(5);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it.each([
    { name: "desktop", width: 1280, height: 900 },
    { name: "mobile", width: 390, height: 844 },
  ])(
    "keeps collapsed paragraphs readable after reload and browser reveal ($name)",
    async (viewport) => {
      const paragraphs = [
        ...Array.from(
          { length: 8 },
          (_, index) =>
            `Background paragraph ${index + 1}. Please review the synthetic project notes and summarize the next steps. Keep the explanation clear enough for someone reading the conversation later.`,
        ),
        ...["First", "Second"].map((label) =>
          [
            `${label} request:`,
            "<review_request>",
            "<input>Read the sample notes and explain the next step,",
            "then describe the expected result.</input>",
            "<context>The sample is ready for review.</context>",
            "</review_request>",
          ].join("\n"),
        ),
        "Final prompt tail: the complete request remains available.",
      ];
      const context = await suite.newBrowserContext({
        locale: "en-US",
        colorScheme: "light",
        serviceWorkers: "block",
        viewport: { width: viewport.width, height: viewport.height },
      });
      const page = await context.newPage();
      await installMockGateway(page, {
        historyMessages: [
          { role: "user", content: paragraphs.join("\n\n"), timestamp: 1 },
          { role: "user", content: "Short follow-up request.", timestamp: 2 },
          { role: "assistant", content: "The sample review is complete.", timestamp: 3 },
        ],
      });

      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        const bubble = page.locator(".chat-group.user .chat-bubble").first();
        const toggle = bubble.getByRole("button", { name: "Show more", exact: true });
        await toggle.waitFor({ state: "visible" });
        await page.reload();
        await toggle.waitFor({ state: "visible" });
        const content = bubble.locator(".chat-message-disclosure__content");
        const markdown = content.locator(".chat-text");
        const initialCollapsedHeight = await content.evaluate((element) => element.clientHeight);
        expect(await content.evaluate((element) => element.scrollTop)).toBe(0);
        expect(await markdown.locator("p").allTextContents()).toEqual(paragraphs);

        // Browser descendant reveal can scroll an overflow-hidden preview without expanding it.
        const revealedParagraph = markdown.locator("p").nth(9);
        await revealedParagraph.scrollIntoViewIfNeeded();
        const geometry = await revealedParagraph.evaluate((paragraph) => {
          const clip = paragraph.closest(".chat-message-disclosure__content");
          if (!clip) {
            throw new Error("Missing user message preview");
          }
          const clipRect = clip.getBoundingClientRect();
          const paragraphRect = paragraph.getBoundingClientRect();
          // Read individual text nodes so BR boxes and duplicate element fragments are excluded.
          const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
          const lines: Array<{ top: number; bottom: number }> = [];
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (!node.textContent?.trim()) {
              continue;
            }
            const range = document.createRange();
            range.selectNodeContents(node);
            for (const rect of range.getClientRects()) {
              if (rect.width > 0 && rect.height > 0) {
                lines.push({ top: rect.top, bottom: rect.bottom });
              }
            }
          }
          return {
            scrollTop: clip.scrollTop,
            clip: { top: clipRect.top, bottom: clipRect.bottom },
            paragraph: { top: paragraphRect.top, bottom: paragraphRect.bottom },
            lines,
          };
        });
        if (captureUiProofEnabled) {
          const artifactDir = path.join(suite.artifactDir, "user-bubble-clamp");
          await page.screenshot({ path: path.join(artifactDir, `${viewport.name}-revealed.png`) });
          await writeFile(
            path.join(artifactDir, `${viewport.name}-geometry.json`),
            `${JSON.stringify(geometry, null, 2)}\n`,
          );
        }
        expect(await toggle.getAttribute("aria-expanded")).toBe("false");
        expect(geometry.scrollTop).toBeGreaterThan(0);
        expect(
          geometry.lines.filter(
            (line) => line.top >= geometry.clip.top && line.bottom <= geometry.clip.bottom,
          ).length,
        ).toBeGreaterThan(0);
        expect(geometry.lines.length).toBeGreaterThanOrEqual(6);
        for (const line of geometry.lines) {
          expect(line.top, "text starts within its own paragraph").toBeGreaterThanOrEqual(
            geometry.paragraph.top - 1,
          );
          expect(
            line.bottom,
            "text ends within its own paragraph without overlapping the next",
          ).toBeLessThanOrEqual(geometry.paragraph.bottom + 1);
        }
        const collapsedHeight = await content.evaluate((element) => element.clientHeight);
        expect(collapsedHeight).toBe(initialCollapsedHeight);

        await toggle.click();
        const collapse = bubble.getByRole("button", { name: "Show less", exact: true });
        expect(await collapse.getAttribute("aria-expanded")).toBe("true");
        expect(await content.evaluate((element) => element.clientHeight)).toBeGreaterThan(
          collapsedHeight,
        );
        expect(
          await content.evaluate((element) => element.scrollHeight - element.clientHeight),
        ).toBeLessThanOrEqual(1);
        const tail = markdown.locator("p").last();
        await tail.scrollIntoViewIfNeeded();
        expect(await tail.textContent()).toBe(paragraphs.at(-1));
        if (captureUiProofEnabled) {
          await page.screenshot({
            path: path.join(
              suite.artifactDir,
              "user-bubble-clamp",
              `${viewport.name}-expanded-tail.png`,
            ),
          });
        }
        await collapse.click();
        expect(await toggle.getAttribute("aria-expanded")).toBe("false");
        expect(await content.evaluate((element) => element.clientHeight)).toBe(
          initialCollapsedHeight,
        );
        const siblings = page.locator(".chat-group .chat-bubble");
        expect(await siblings.nth(1).textContent()).toContain("Short follow-up request.");
        expect(await siblings.nth(2).textContent()).toContain("The sample review is complete.");
        const boxes = await siblings.evaluateAll((elements) =>
          elements.map((element) => {
            const rect = element.getBoundingClientRect();
            return { top: rect.top, bottom: rect.bottom };
          }),
        );
        expect(boxes).toHaveLength(3);
        for (const [index, box] of boxes.entries()) {
          const previous = boxes[index - 1];
          if (previous) {
            expect(previous.bottom).toBeLessThanOrEqual(box.top + 1);
          }
        }
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );
});
