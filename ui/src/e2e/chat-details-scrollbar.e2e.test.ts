import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { closeChatDetails, openChatDetails } from "./chat-details.test-support.ts";
import { seedChatSettings } from "./chat-layout-fixtures.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Details transcript scrollbar",
  // Chromium headless otherwise hides the scrollbar this scenario exercises.
  browserLaunchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] },
});
const sessionKey = "agent:main:main";

async function geometry(page: Page) {
  return page.evaluate(() => {
    const box = (selector: string) => {
      const { left, right, width } = document.querySelector(selector)!.getBoundingClientRect();
      return { left, right, width };
    };
    return {
      frame: box(".chat-main__conversation-frame"),
      thread: box(".chat-thread"),
      column: box(".chat-thread-inner"),
      composer: box(".agent-chat__composer-shell"),
      details: box(".chat-details"),
    };
  });
}

type DetailsMotionFrame = {
  open: boolean;
  detailsLeft: number;
  detailsWidth: number;
  detailsHeight: number;
  detailsDisplay: string;
  detailsPadding: string;
  detailsBackground: string;
  frameRight: number;
  threadRight: number;
  threadWidth: number;
  anchorTop: number;
  columnCenter: number;
  composerCenter: number;
  scrollTop: number;
};

declare global {
  interface Window {
    detailsMotionProbe?: { frames: DetailsMotionFrame[]; stop: () => void };
  }
}

async function captureDetailsMotion(
  page: Page,
  input: "pointer" | "reversed" | "keyboard" = "pointer",
) {
  await page.evaluate(() => {
    const thread = document.querySelector<HTMLElement>(".chat-thread")!;
    const frame = document.querySelector<HTMLElement>(".chat-main__conversation-frame")!;
    const column = document.querySelector<HTMLElement>(".chat-thread-inner")!;
    const composer = document.querySelector<HTMLElement>(".agent-chat__composer-shell")!;
    const details = document.querySelector<HTMLElement>(".chat-details")!;
    const trigger = document.querySelector<HTMLButtonElement>(".chat-details-toggle")!;
    const threadBounds = thread.getBoundingClientRect();
    const anchor = [...thread.querySelectorAll<HTMLElement>(".chat-group")].find((group) => {
      const box = group.getBoundingClientRect();
      return box.top >= threadBounds.top && box.bottom <= threadBounds.bottom;
    })!;
    const probe = { frames: [] as DetailsMotionFrame[], stop: () => {} };
    window.detailsMotionProbe = probe;
    let handle = 0;
    const sample = () => {
      const columnBox = column.getBoundingClientRect();
      const composerBox = composer.getBoundingClientRect();
      const detailsBox = details.getBoundingClientRect();
      const detailsStyle = getComputedStyle(details);
      probe.frames.push({
        open: trigger.getAttribute("aria-expanded") === "true",
        detailsLeft: detailsBox.left,
        detailsWidth: detailsBox.width,
        detailsHeight: detailsBox.height,
        detailsDisplay: detailsStyle.display,
        detailsPadding: detailsStyle.padding,
        detailsBackground: detailsStyle.backgroundColor,
        frameRight: frame.getBoundingClientRect().right,
        threadRight: thread.getBoundingClientRect().right,
        threadWidth: thread.getBoundingClientRect().width,
        anchorTop: anchor.getBoundingClientRect().top,
        columnCenter: columnBox.left + columnBox.width / 2,
        composerCenter: composerBox.left + composerBox.width / 2,
        scrollTop: thread.scrollTop,
      });
      handle = requestAnimationFrame(sample);
    };
    probe.stop = () => cancelAnimationFrame(handle);
    sample();
  });
  const trigger = page.locator(".chat-details-toggle:visible");
  if (input === "keyboard") {
    await trigger.press("Enter");
  } else {
    await trigger.click();
  }
  if (input === "reversed") {
    // Reverse a moving surface, including floating Details without a reserved column.
    await page.evaluate(async () => {
      const frames = window.detailsMotionProbe!.frames;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        if (frames.some((frame) => Math.abs(frame.detailsLeft - frames[0]!.detailsLeft) > 1)) {
          return;
        }
        await new Promise(requestAnimationFrame);
      }
      throw new Error("Details never began moving before the interruption");
    });
    await trigger.click();
  }
  await page.locator(".chat-main__conversation-frame").evaluate(async (frame) => {
    await Promise.all(
      frame
        .getAnimations({ subtree: true })
        .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
        .map((animation) => animation.finished.catch(() => undefined)),
    );
    await new Promise(requestAnimationFrame);
  });
  return page.evaluate(() => {
    const probe = window.detailsMotionProbe!;
    probe.stop();
    delete window.detailsMotionProbe;
    return probe.frames;
  });
}

function expectSteadyDetailsMotion(frames: DetailsMotionFrame[]) {
  expect(frames.length).toBeGreaterThan(1);
  const painted = frames.filter((frame) => frame.detailsDisplay !== "none");
  expect(painted.length).toBeGreaterThan(0);
  for (const key of ["detailsWidth", "detailsHeight"] as const) {
    const values = painted.map((frame) => frame[key]);
    expect(Math.max(...values) - Math.min(...values)).toBeLessThan(1);
  }
  for (const frame of painted) {
    expect(frame.detailsPadding).toBe(painted[0]!.detailsPadding);
    expect(frame.detailsBackground).toBe(painted[0]!.detailsBackground);
  }
  const last = frames.at(-1)!;
  expect(last.detailsDisplay === "none").toBe(!last.open);
  for (const key of ["threadWidth", "anchorTop", "scrollTop"] as const) {
    const values = frames.map((frame) => frame[key]);
    expect(Math.max(...values) - Math.min(...values)).toBeLessThan(1);
  }
  for (const [left, right] of [
    ["threadRight", "frameRight"],
    ["columnCenter", "composerCenter"],
  ] as const) {
    expect(Math.max(...frames.map((frame) => Math.abs(frame[left] - frame[right])))).toBeLessThan(
      1,
    );
  }
  for (let index = 1; index < frames.length; index += 1) {
    const before = frames[index - 1]!;
    const after = frames[index]!;
    if (before.open === after.open) {
      const movement = after.columnCenter - before.columnCenter;
      expect(after.open ? movement : -movement).toBeLessThanOrEqual(1);
    }
  }
}

suite.define(() => {
  it("keeps the scrollbar at the conversation edge while Details leaves messages and the composer clear", async () => {
    await suite.withPage(
      {
        viewport: { width: 1900, height: 1000 },
        colorScheme: "dark",
      },
      async ({ page }) => {
        await seedChatSettings(page, suite.server.baseUrl, { themeMode: "dark" });
        await installMockGateway(page, {
          sessionKey,
          methodResponses: {
            "sessions.files.list": {
              sessionKey,
              root: "/workspace/release-review",
              gitCheckout: true,
              files: [],
              browser: { path: "", entries: [] },
            },
          },
          sessions: [
            {
              key: sessionKey,
              sessionId: "details-scrollbar",
              kind: "direct",
              label: "Review release notes",
            },
          ],
          historyMessages: Array.from({ length: 24 }, (_, index) => ({
            role: index % 2 === 0 ? "user" : "assistant",
            content:
              index % 2 === 0
                ? `Review item ${index + 1}: check the next release note.`
                : `### Release review ${index + 1}\n\nThe updated session view keeps the conversation readable while supporting project files and progress details.\n\n- Review the change in context.\n- Verify the result in the application.\n- Record the outcome for the release.`,
          })),
          workspace: "/workspace/release-review",
          workspaceGit: true,
        });
        await page.goto(suite.server.baseUrl + "chat");
        const thread = page.locator(".chat-thread");
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.waitFor();
        await openChatDetails(page);
        await page.locator(".chat-details-desktop-body").waitFor();
        await composer.fill("Keep this draft while checking the layout.");
        await thread.hover();
        await page.mouse.wheel(0, -450);
        await expect
          .poll(() =>
            thread.evaluate(
              (element) => element.scrollTop + element.clientHeight < element.scrollHeight - 100,
            ),
          )
          .toBe(true);
        const motion = {
          close: await captureDetailsMotion(page),
          open: await captureDetailsMotion(page),
          reversed: await captureDetailsMotion(page, "reversed"),
        };
        const keyboard = {
          close: await captureDetailsMotion(page, "keyboard"),
          open: await captureDetailsMotion(page, "keyboard"),
        };
        await page.emulateMedia({ reducedMotion: "reduce" });
        const reduced = {
          close: await captureDetailsMotion(page),
          open: await captureDetailsMotion(page),
        };
        await page.emulateMedia({ reducedMotion: "no-preference" });
        for (const frames of [
          ...Object.values(motion),
          ...Object.values(keyboard),
          ...Object.values(reduced),
        ]) {
          expectSteadyDetailsMotion(frames);
        }
        for (const frames of [...Object.values(keyboard), ...Object.values(reduced)]) {
          const endpoints = new Set([frames[0]!.columnCenter, frames.at(-1)!.columnCenter]);
          expect(frames.every((frame) => endpoints.has(frame.columnCenter))).toBe(true);
        }
        await thread.hover();
        await page.mouse.wheel(0, -1);
        const initial = await geometry(page);
        expect(initial.thread.right).toBeCloseTo(initial.frame.right, 0);
        expect(initial.frame.right - initial.details.right).toBe(13);
        // A wider box alone is insufficient if an ancestor still clips its scrollbar.
        expect(
          await thread.evaluate((element) => {
            const box = element.getBoundingClientRect();
            return (
              element.ownerDocument.elementFromPoint(box.right - 2, box.top + box.height / 2) ===
              element
            );
          }),
        ).toBe(true);
        expect(initial.column.left + initial.column.width / 2).toBeCloseTo(
          initial.composer.left + initial.composer.width / 2,
          0,
        );
        expect(initial.column.right).toBeLessThan(initial.details.left);
        expect(initial.composer.right).toBeLessThan(initial.details.left);
        const scrollBefore = await thread.evaluate((element) => element.scrollTop);
        await thread.focus();
        await page.keyboard.press("PageUp");
        await expect
          .poll(() => thread.evaluate((element) => element.scrollTop))
          .toBeLessThan(scrollBefore);
        await closeChatDetails(page);
        await openChatDetails(page);
        await expect
          .poll(async () => (await geometry(page)).thread.right)
          .toBeCloseTo(initial.frame.right, 0);
        expect(await composer.inputValue()).toBe("Keep this draft while checking the layout.");
        for (const width of [1510, 1509, 1100, 1900]) {
          await page.setViewportSize({ width, height: 1000 });
          await openChatDetails(page);
          await expect
            .poll(async () => {
              const boxes = await geometry(page);
              return Math.abs(boxes.thread.right - boxes.frame.right);
            })
            .toBeLessThan(1);
        }
        await openChatSidePanelType(page, "Files");
        await page.locator('[data-panel-slot="workspace"]:visible').waitFor();
        await expect
          .poll(async () => {
            const boxes = await geometry(page);
            return Math.abs(boxes.thread.right - boxes.frame.right);
          })
          .toBeLessThan(1);
        await page.setViewportSize({ width: 1440, height: 1000 });
        await openChatDetails(page);
        expect(
          await page
            .locator(".chat-details")
            .evaluate((panel) => panel.classList.contains("chat-details--docked")),
        ).toBe(false);
        for (const reducedMotion of ["no-preference", "reduce"] as const) {
          await page.emulateMedia({ reducedMotion });
          const inputs =
            reducedMotion === "reduce"
              ? (["pointer", "pointer"] as const)
              : (["pointer", "pointer", "reversed"] as const);
          for (const input of inputs) {
            expectSteadyDetailsMotion(await captureDetailsMotion(page, input));
          }
        }
        const side = await page.locator('[data-region="side"]:visible').boundingBox();
        expect((await geometry(page)).thread.right).toBeLessThanOrEqual(side!.x);
        await composer.click();
        expect(await composer.evaluate((element) => element === document.activeElement)).toBe(true);
      },
    );
  });
});
