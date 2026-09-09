import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Subagent task notice" });

suite.define(() => {
  it.each([1440, 768])("keeps task progress above the view-only footer at %ipx", async (width) => {
    await suite.withPage(
      { viewport: { width, height: 900 }, colorScheme: "dark" },
      async ({ page }) => {
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
        const progress = shell.locator(".session-progress-card--composer");
        const body = progress.locator(".session-progress-card__body");
        await notice.getByText("View-only subagent", { exact: true }).waitFor();
        await progress.waitFor();
        expect(await shell.locator("textarea").count()).toBe(0);
        expect(
          await notice.evaluate((element) =>
            Boolean(
              element.previousElementSibling?.classList.contains("agent-chat__progress-float"),
            ),
          ),
        ).toBe(true);
        expect(
          await notice.evaluate((element) => element === element.parentElement?.lastElementChild),
        ).toBe(true);
        if (!(await progress.evaluate((element) => element.hasAttribute("open")))) {
          await progress.locator("summary").click();
        }
        await expect
          .poll(() =>
            body.evaluate((element) => {
              const bounds = element.getBoundingClientRect();
              const footer = element
                .closest(".agent-chat__composer-shell")!
                .querySelector(".agent-chat__disabled-banner--replacement")!
                .getBoundingClientRect();
              return (
                bounds.height > 0 && bounds.bottom <= footer.top + 1 && footer.bottom <= innerHeight
              );
            }),
          )
          .toBe(true);
        expect(await body.evaluate((element) => getComputedStyle(element).overflowY)).toBe("auto");
        expect(await body.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
          true,
        );
        const footerTop = await notice.evaluate((element) => element.getBoundingClientRect().top);
        await body.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        expect(await body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        expect(await notice.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(
          footerTop,
          0,
        );
        await progress.locator("summary").click();
        await expect.poll(() => progress.getAttribute("open")).toBeNull();
        await notice.getByRole("button", { name: "Open parent session", exact: true }).click();
        const input = shell.locator(".agent-chat__input");
        await input.locator("textarea").fill("Continue the review");
        await progress.waitFor();
        expect(
          await input.evaluate((element) =>
            Boolean(
              element.previousElementSibling?.classList.contains("agent-chat__progress-float"),
            ),
          ),
        ).toBe(true);
        expect(
          await input.evaluate((element) => element === element.parentElement?.lastElementChild),
        ).toBe(true);
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
