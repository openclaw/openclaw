import { expect, type Locator } from "playwright/test";
import { it } from "vitest";
import { finishElementAnimations } from "../test-helpers/animations.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import type { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

export async function readFooterGeometry(group: Locator) {
  return group.locator(".chat-group-footer").evaluate((footer) => {
    const actions = footer.querySelector<HTMLElement>(".chat-group-footer-actions");
    const identity = footer.querySelector<HTMLElement>(".chat-group-footer__meta");
    const name = footer.querySelector<HTMLElement>(".chat-sender-name");
    if (!actions || !identity || !name) {
      throw new Error("Expected message footer identity and actions");
    }
    const actionsRect = actions.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();
    const identityRect = identity.getBoundingClientRect();
    const nameRect = name.getBoundingClientRect();
    return {
      actions: {
        left: actionsRect.left,
        right: actionsRect.right,
        top: actionsRect.top,
        bottom: actionsRect.bottom,
      },
      identity: {
        top: identityRect.top,
        bottom: identityRect.bottom,
        left: identityRect.left,
        right: identityRect.right,
      },
      footer: { right: footerRect.right },
      name: { left: nameRect.left - footerRect.left, top: nameRect.top - footerRect.top },
    };
  });
}

export async function readActionTapArea(control: Locator) {
  await control.scrollIntoViewIfNeeded();
  return control.evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const extension = getComputedStyle(button, "::before");
    const width = extension.content === "none" ? rect.width : Number.parseFloat(extension.width);
    const height = extension.content === "none" ? rect.height : Number.parseFloat(extension.height);
    const left = rect.left + (rect.width - width) / 2;
    const top = rect.top + (extension.content === "none" ? 0 : Number.parseFloat(extension.top));
    // Mobile hit testing rounds fractional CSS edges; probe 2px inside them.
    // Target dimensions and containment are checked separately.
    const corners: Array<[number, number]> = [
      [left + 2, top + 2],
      [left + width - 2, top + 2],
      [left + 2, top + height - 2],
      [left + width - 2, top + height - 2],
    ];
    return {
      left,
      top,
      width,
      height,
      hitCorners: corners.filter(
        ([x, y]) => document.elementFromPoint(x, y)?.closest("button") === button,
      ).length,
    };
  });
}

export function expectStableNamePosition(
  actual: { left: number; top: number },
  expected: { left: number; top: number },
) {
  expect(actual.left).toBe(expected.left);
  expect(actual.top).toBeCloseTo(expected.top, 0);
}

export function defineMobileFooterActionCases(suite: ReturnType<typeof createControlUiE2eSuite>) {
  it.each([320, 390])("keeps revealed assistant controls compact at %s px", async (width) => {
    await suite.withPage(
      {
        viewport: { width, height: 844 },
        isMobile: true,
        deviceScaleFactor: 2,
        hasTouch: true,
        permissions: ["clipboard-read", "clipboard-write"],
      },
      async ({ page }) => {
        const reply = "The reply, its metadata, and its controls stay together.";
        const timestamp = Date.now() - 7_200_000;
        await installMockGateway(page, {
          assistantName: "RoboClaw Frontend Engineer",
          historyMessages: [
            { role: "user", content: "Check the mobile controls.", timestamp },
            {
              role: "assistant",
              content: reply,
              timestamp: timestamp + 1000,
              model: "gpt-5.5",
              usage: { input: 4231, output: 217 },
            },
            {
              role: "user",
              content: "Keep the default visibility unchanged.",
              timestamp: timestamp + 2000,
            },
            {
              role: "assistant",
              content: "I will inspect the earlier reply by tapping it.",
              timestamp: timestamp + 3000,
            },
          ],
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
        const agent = page.locator(".chat-group.assistant").first();
        const footer = agent.locator(".chat-group-footer");
        await expect(agent).toContainText(reply);
        await expect(footer).toHaveCSS("opacity", "0");
        const restingHeight = (await agent.boundingBox())?.height;
        await agent.locator(".chat-bubble").tap();
        await expect(footer).toHaveCSS("opacity", "1");
        const geometry = await readFooterGeometry(agent);
        expect(geometry.actions.top).toBeLessThan(geometry.identity.bottom);
        expect(geometry.actions.left - geometry.identity.right).toBeCloseTo(8, 0);
        expect(geometry.actions.right).toBeLessThanOrEqual(geometry.footer.right + 1);
        const alignment = await footer.evaluate((element) => {
          const time = element.querySelector(".chat-group-timestamp")!.getBoundingClientRect();
          const icon = element.querySelector(".chat-reply-btn svg")!.getBoundingClientRect();
          return {
            timeHeight: time.height,
            centers: Math.abs(time.top + time.height / 2 - icon.top - icon.height / 2),
          };
        });
        expect(alignment.timeHeight).toBeLessThan(20);
        expect(alignment.centers).toBeLessThanOrEqual(1);
        expect((await agent.boundingBox())?.height).toBe(restingHeight);
        const copy = agent.locator(".chat-copy-btn");
        const target = await copy.boundingBox();
        expect(target?.width).toBe(24);
        expect(target?.height).toBe(24);
        const tapArea = await readActionTapArea(copy);
        expect(tapArea.width).toBeGreaterThanOrEqual(44);
        expect(tapArea.height).toBeGreaterThanOrEqual(44);
        expect(tapArea.hitCorners).toBe(4);
        const bubble = await agent.locator(".chat-bubble").boundingBox();
        const groupBox = await agent.boundingBox();
        expect(tapArea.top).toBeGreaterThanOrEqual(bubble!.y + bubble!.height);
        expect(tapArea.top + tapArea.height).toBeLessThanOrEqual(groupBox!.y + groupBox!.height);
        // This point is below and outside the painted button, inside its real tap area.
        await page.touchscreen.tap(tapArea.left + 2, tapArea.top + tapArea.height - 2);
        await expect(copy).toHaveAttribute("data-copy-state", "copied");
        await copy.evaluate(finishElementAnimations);
        await expect
          .poll(() =>
            copy.evaluate((button) => ({
              state: button.dataset.copyState,
              painted: getComputedStyle(button).backgroundColor !== "rgba(0, 0, 0, 0)",
            })),
          )
          .toEqual({ state: "copied", painted: true });
        const centered = await copy.evaluate((button) => {
          const box = button.getBoundingClientRect();
          const icon = button
            .querySelector(".chat-copy-btn__icon-check svg")!
            .getBoundingClientRect();
          return {
            x: Math.abs(box.x + box.width / 2 - icon.x - icon.width / 2),
            y: Math.abs(box.y + box.height / 2 - icon.y - icon.height / 2),
          };
        });
        expect(centered.x).toBeLessThanOrEqual(1);
        expect(centered.y).toBeLessThanOrEqual(1);
        expect(await copy.boundingBox()).toEqual(target);
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(reply);
        await expect(copy).not.toHaveAttribute("data-copy-state", "copied");
        if (width === 390) {
          await copy.focus();
          await page.keyboard.press("Enter");
          await expect(copy).toHaveAttribute("data-copy-state", "copied");
          await expect(copy).not.toHaveAttribute("data-copy-state", "copied");
        }
        await agent.locator(".chat-bubble").tap();
        await page.getByRole("textbox", { name: "Chat composer" }).tap();
        await expect(footer).toHaveCSS("opacity", "0");
        expect((await readActionTapArea(copy)).hitCorners).toBe(0);
      },
    );
  });
}
