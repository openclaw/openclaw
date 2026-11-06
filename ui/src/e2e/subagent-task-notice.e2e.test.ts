import { expect, it } from "vitest";
import { waitForLayoutSettled } from "../pages/chat/chat-layout.browser.test-support.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  closeChatDetails,
  openChatDetails,
  openChatTaskProgress,
} from "./chat-details.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Subagent task notice" });

suite.define(() => {
  it.each([1440, 768])("keeps progress and the view-only footer usable at %ipx", async (width) => {
    await suite.withPage(
      { viewport: { width, height: 900 }, colorScheme: "dark" },
      async ({ page }) => {
        const parent = {
          key: "agent:main:task-parent",
          kind: "direct",
          label: "Workspace review",
        };
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
          communityInvite: false,
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
                    markdown: Array.from(
                      { length: 12 },
                      (_, index) => `## Area ${index + 1}\n\nThe review of this area is complete.`,
                    ).join("\n\n"),
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
        await notice.getByText("View-only subagent", { exact: true }).waitFor();
        expect(await pane.locator(".task-progress-details__plan").isVisible()).toBe(false);
        const progress = await openChatTaskProgress(pane);
        const details = await openChatDetails(pane);
        const mobile = width === 768;
        const scrollport = mobile
          ? progress.locator(".chat-mobile-details-page__body")
          : details.locator(".chat-details-desktop-body");
        expect(await shell.locator(".session-progress-card, textarea").count()).toBe(0);
        if (!mobile && !(await progress.evaluate((element) => element.hasAttribute("open")))) {
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
            const top = await details.evaluate((element) => {
              const bounds = element.getBoundingClientRect();
              const footer = element
                .closest("openclaw-chat-pane")!
                .querySelector(".agent-chat__disabled-banner--replacement")!
                .getBoundingClientRect();
              return bounds.height > 0 &&
                bounds.bottom <= innerHeight &&
                footer.height > 0 &&
                (bounds.bottom <= footer.top + 1 ||
                  bounds.top >= footer.bottom - 1 ||
                  bounds.right <= footer.left ||
                  bounds.left >= footer.right) &&
                footer.bottom <= innerHeight
                ? footer.top
                : null;
            });
            if (top === null) {
              return false;
            }
            footerTop = top;
            return true;
          })
          .toBe(true);
        expect(
          await scrollport.evaluate((element) => ({
            overflow: getComputedStyle(element).overflowY,
            scrollable: element.scrollHeight > element.clientHeight,
          })),
        ).toEqual({ overflow: "auto", scrollable: true });
        await scrollport.hover();
        await page.mouse.wheel(0, 1000);
        await expect
          .poll(() => scrollport.evaluate((element) => element.scrollTop))
          .toBeGreaterThan(0);
        expect(await notice.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(
          footerTop,
          0,
        );
        await notice.getByRole("button", { name: "Open parent session", exact: true }).click({
          trial: true,
        });
        if (mobile) {
          await details
            .locator(".chat-mobile-host__header")
            .getByRole("button", { name: "Back", exact: true })
            .click();
          await progress.waitFor({ state: "hidden" });
          await closeChatDetails(pane);
        } else {
          await progress.locator("summary").click();
          await expect.poll(() => progress.getAttribute("open")).toBeNull();
        }
        await notice.getByRole("button", { name: "Open parent session", exact: true }).click();
        const input = shell.locator(".agent-chat__input");
        await input.locator("textarea").fill("Continue the review");
        await openChatTaskProgress(pane);
        expect(await input.locator("textarea").inputValue()).toBe("Continue the review");
        if (!mobile) {
          // Floating desktop Details keeps its approved composer-bottom alignment.
          await closeChatDetails(pane);
        }
        await expect
          .poll(() =>
            input.evaluate((element) => {
              const inputBounds = element.getBoundingClientRect();
              const detailsBounds = element
                .closest("openclaw-chat-pane")!
                .querySelector(
                  ".sidebar-region--mobile-host > .chat-mobile-host:not([hidden]), .chat-details[data-open]:not(.chat-mobile-host .chat-details)",
                )
                ?.getBoundingClientRect();
              return (
                (!detailsBounds ||
                  (detailsBounds.height > 0 &&
                    detailsBounds.bottom <= innerHeight &&
                    (detailsBounds.bottom <= inputBounds.top + 1 ||
                      detailsBounds.top >= inputBounds.bottom - 1 ||
                      detailsBounds.right <= inputBounds.left ||
                      detailsBounds.left >= inputBounds.right))) &&
                inputBounds.bottom <= innerHeight
              );
            }),
          )
          .toBe(true);
        await input.locator(".chat-send-btn--send:visible").click({ trial: true });
        expect(await pane.getByText("View-only subagent", { exact: true }).count()).toBe(0);
        expect(await gateway.getRequests("progressCard.get")).toContainEqual(
          expect.objectContaining({
            params: expect.objectContaining({ sessionKey: parent.key }),
          }),
        );
      },
    );
  });
});
