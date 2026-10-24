import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { waitForChatScrollIdle } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI selection dismissal" });
const passage = "Review the deployment checklist.";

function withTranscript(
  run: (page: Page, source: Locator, thread: Locator, toolbar: Locator) => Promise<void>,
) {
  return suite.withPage(
    { viewport: { width: 1440, height: 900 }, locale: "en-US", reducedMotion: "reduce" },
    async ({ page }) => {
      await installMockGateway(page, {
        historyMessages: [
          ...Array.from({ length: 18 }, (_, index) => ({
            role: index % 2 ? "assistant" : "user",
            content: `Earlier message ${index}.`,
          })),
          { role: "assistant", content: passage },
        ],
      });
      await page.goto(suite.server.baseUrl + "chat");
      const source = page.locator(".chat-bubble .chat-text p").filter({ hasText: passage });
      await source.waitFor({ state: "visible" });
      await waitForChatScrollIdle(page);
      await run(
        page,
        source,
        page.locator(".chat-thread").filter({ has: source }),
        page.getByRole("toolbar", { name: "Selection actions" }),
      );
    },
  );
}

async function selectWord(source: Locator, toolbar: Locator) {
  await source.dblclick({ position: { x: 12, y: 8 } });
  await toolbar.waitFor({ state: "visible" });
  expect(await source.page().evaluate(() => window.getSelection()?.toString())).toBe("Review");
}

suite.define(() => {
  it.each(["open", "Escape", "scroll"])(
    "clears selected text on a blank click after %s",
    async (phase) => {
      await withTranscript(async (page, source, thread, toolbar) => {
        await selectWord(source, toolbar);
        if (phase === "Escape") {
          await page.keyboard.press("Escape");
        } else if (phase === "scroll") {
          const previous = await thread.evaluate((element) => element.scrollTop);
          await thread.hover({ position: { x: 4, y: 100 } });
          await page.mouse.wheel(0, -50);
          await expect
            .poll(() => thread.evaluate((element) => element.scrollTop))
            .not.toBe(previous);
        }
        if (phase !== "open") {
          await toolbar.waitFor({ state: "detached" });
          expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("Review");
        }
        await thread.click({ position: { x: 4, y: 4 } });
        await expect.poll(() => page.evaluate(() => window.getSelection()?.isCollapsed)).toBe(true);
        expect(await toolbar.count()).toBe(0);
      });
    },
  );

  it.each(["Add to chat", "Ask in side chat"])(
    "preserves the selected passage until %s activates",
    async (label) => {
      await withTranscript(async (page, source, _thread, toolbar) => {
        await selectWord(source, toolbar);
        const button = toolbar.getByRole("button", { name: label, exact: true });
        const bounds = await button.boundingBox();
        if (!bounds) {
          throw new Error("Selection action has no visible bounds");
        }
        await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        await page.mouse.down();
        expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("Review");
        await page.mouse.up();
        await page.getByRole("dialog", { name: "Comment", exact: true }).waitFor();
        expect(
          await page.evaluate(() =>
            Array.from(CSS.highlights.get("openclaw-comment") ?? [])
              .map((range) => (range instanceof Range ? range.toString() : ""))
              .join(""),
          ),
        ).toBe("Review");
      });
    },
  );

  it("keeps the selection toolbar dismissed when a message control is clicked", async () => {
    await withTranscript(async (page, source, _thread, toolbar) => {
      await selectWord(source, toolbar);
      await page.keyboard.press("Escape");
      const group = page.locator(".chat-group").filter({ has: source });
      await source.hover();
      const copy = group.locator(".chat-group-footer .chat-copy-btn");
      await copy.click();
      await expect.poll(() => copy.getAttribute("data-copy-state")).toBe("copied");
      expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("Review");
      expect(await toolbar.count()).toBe(0);
    });
  });

  it("reopens for a new selection of the same word after Escape", async () => {
    await withTranscript(async (page, source, _thread, toolbar) => {
      await selectWord(source, toolbar);
      await page.keyboard.press("Escape");
      await toolbar.waitFor({ state: "detached" });
      await selectWord(source, toolbar);
    });
  });

  it.each(["outside", "cancel", "other pointer"])(
    "retires the owned gesture after %s and accepts later selections",
    async (ending) => {
      await withTranscript(async (page, source, _thread, toolbar) => {
        const bounds = await source.boundingBox();
        if (!bounds) {
          throw new Error("Selection source has no visible bounds");
        }
        await page.mouse.move(bounds.x + 1, bounds.y + 8);
        await source.evaluate((element) => {
          element.addEventListener(
            "pointerdown",
            (event) => {
              element.setAttribute(
                "data-test-pointer-id",
                String((event as PointerEvent).pointerId),
              );
            },
            { once: true },
          );
        });
        await page.mouse.down();
        const ownedPointer = Number(await source.getAttribute("data-test-pointer-id"));
        await page.mouse.move(bounds.x + 150, bounds.y + 8, { steps: 8 });
        if (ending === "outside") {
          await page.mouse.move(1445, bounds.y + 8);
        } else {
          // Inject the cancellation boundary; the following mouse input is native.
          await source.dispatchEvent("pointercancel", {
            pointerId: ownedPointer + (ending === "other pointer" ? 1 : 0),
            pointerType: "mouse",
          });
        }
        await page.mouse.up();
        if (ending === "other pointer") {
          await toolbar.waitFor({ state: "visible" });
          await page.keyboard.press("Escape");
        } else {
          expect(await toolbar.count()).toBe(0);
        }
        const header = await page.locator(".chat-pane__header").first().boundingBox();
        if (!header) {
          throw new Error("Transcript header has no visible bounds");
        }
        await page.mouse.move(header.x + 10, header.y + 10);
        await page.mouse.down();
        await page.mouse.move(bounds.x + 12, bounds.y + 8);
        await page.mouse.up();
        expect(await toolbar.count()).toBe(0);
        await selectWord(source, toolbar);
      });
    },
  );

  it("lets Shift extend the native selected passage", async () => {
    await withTranscript(async (page, source, _thread, toolbar) => {
      await selectWord(source, toolbar);
      await page.keyboard.down("Shift");
      await source.click({ position: { x: 150, y: 8 } });
      await page.keyboard.up("Shift");
      expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
        "Review the deployment ",
      );
    });
  });

  it("copies the selected passage through the native context gesture", async () => {
    await withTranscript(async (page, source, _thread, toolbar) => {
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      await selectWord(source, toolbar);
      await page.keyboard.press("Escape");
      await source.click({ button: "right", position: { x: 12, y: 8 } });
      await page.getByRole("menuitem", { name: "Copy", exact: true }).click();
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("Review");
    });
  });
});
