import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { waitForLayoutSettled } from "../pages/chat/chat-layout.browser.test-support.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { openChatDetails } from "./chat-details.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Subagent task notice" });

function footerClearOfDetails(details: Locator, footerSelector: string, margin = 1) {
  return details.evaluate(
    (element, { selector, tolerance }) => {
      const bounds = element.getBoundingClientRect();
      const footer = element
        .closest("openclaw-chat-pane")!
        .querySelector(selector)!
        .getBoundingClientRect();
      return bounds.height > 0 &&
        bounds.bottom <= innerHeight &&
        footer.height > 0 &&
        (bounds.bottom <= footer.top + tolerance ||
          bounds.top >= footer.bottom - tolerance ||
          bounds.right <= footer.left ||
          bounds.left >= footer.right) &&
        footer.bottom <= innerHeight
        ? footer.top
        : null;
    },
    { selector: footerSelector, tolerance: margin },
  );
}

suite.define(() => {
  it.each([1440, 768])("keeps progress and the view-only footer usable at %ipx", (width) =>
    suite.withPage({ viewport: { width, height: 900 }, colorScheme: "dark" }, async ({ page }) => {
      const parent = { key: "agent:main:task-parent", kind: "direct", label: "Workspace review" };
      const child = {
        key: "agent:main:subagent:task-child",
        kind: "direct",
        label: "Review report",
        spawnedBy: parent.key,
        parentSessionKey: parent.key,
        status: "done",
        hasActiveRun: false,
        endedAt: Date.now() - 8 * 86_400_000,
      };
      const gateway = await installMockGateway(page, {
        sessionKey: child.key,
        sessions: [parent, child],
        historyMessages: [{ role: "assistant", content: "The workspace review is complete." }],
        featureMethods: ["chat.metadata", "chat.startup", "progressCard.get"],
        methodResponses: {
          "progressCard.get": {
            cases: [child.key, parent.key].map((sessionKey) => ({
              match: { sessionKey },
              response: {
                card: {
                  sessionKey,
                  markdown: "## Area reviewed\n\nThe review of this area is complete.\n\n".repeat(
                    12,
                  ),
                  revision: 1,
                  updatedAt: child.endedAt,
                },
              },
            })),
          },
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, child.key));
      const pane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
      const shell = pane.locator(".agent-chat__composer-shell");
      const notice = shell.locator(".agent-chat__disabled-banner--replacement");
      const progress = pane.locator('[data-progress-card-placement="details"]');
      await notice.getByText("View-only subagent", { exact: true }).waitFor();
      await progress.waitFor({ state: "attached" });
      expect(await progress.isVisible()).toBe(false);
      const details = await openChatDetails(pane);
      await progress.waitFor();
      expect(await shell.locator(".session-progress-card, textarea").count()).toBe(0);
      if (!(await progress.evaluate((element) => element.hasAttribute("open")))) {
        await progress.locator("summary").click();
      }
      await waitForLayoutSettled(
        page,
        "openclaw-chat-pane.chat-pane-cache__pane--active :is(.chat-details, .agent-chat__disabled-banner--replacement)",
      );
      // Capture the baseline with the layout check, before a reactive banner replacement.
      let footerTop = 0;
      await expect
        .poll(async () => {
          const top = await footerClearOfDetails(
            details,
            ".agent-chat__disabled-banner--replacement",
            1,
          );
          footerTop = top ?? 0;
          return top !== null;
        })
        .toBe(true);
      expect(
        await details.evaluate((element) => ({
          overflow: getComputedStyle(element).overflowY,
          scrollable: element.scrollHeight > element.clientHeight,
        })),
      ).toEqual({ overflow: "auto", scrollable: true });
      await details.hover();
      await page.mouse.wheel(0, 1000);
      await expect.poll(() => details.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      expect(await notice.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(
        footerTop,
        0,
      );
      const openParent = notice.getByRole("button", { name: "Open parent session", exact: true });
      await openParent.click({ trial: true });
      await progress.locator("summary").click();
      await expect.poll(() => progress.getAttribute("open")).toBeNull();
      await openParent.click();
      const input = shell.locator(".agent-chat__input");
      await input.locator("textarea").fill("Continue the review");
      await openChatDetails(pane);
      await progress.waitFor();
      expect(await input.locator("textarea").inputValue()).toBe("Continue the review");
      await expect.poll(() => footerClearOfDetails(details, ".agent-chat__input")).not.toBeNull();
      await input.locator(".chat-send-btn--send:visible").click({ trial: true });
      expect(await pane.getByText("View-only subagent", { exact: true }).count()).toBe(0);
      expect(
        (await gateway.getRequests("progressCard.get")).map(({ params }) => params),
      ).toContainEqual(expect.objectContaining({ sessionKey: parent.key }));
    }),
  );
});
