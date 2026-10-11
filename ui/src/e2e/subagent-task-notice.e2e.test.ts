import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { openChatDetails } from "./chat-details.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Subagent task notice" });

suite.define(() => {
  it.each([1440, 768])("keeps task progress above the view-only footer at %ipx", async (width) => {
    await suite.withPage(
      { viewport: { width, height: 900 }, colorScheme: "dark" },
      async ({ page }) => {
        const artifactRoot = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
        const proofDir = artifactRoot
          ? createControlUiE2eArtifactDir("subagent-task-notice", artifactRoot)
          : undefined;
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
        const progress = pane.locator('[data-progress-card-placement="details"]');
        await notice.getByText("View-only subagent", { exact: true }).waitFor();
        await progress.waitFor({ state: "attached" });
        expect(await progress.isVisible()).toBe(false);
        const details = await openChatDetails(pane);
        await progress.waitFor();
        expect(await shell.locator(".session-progress-card").count()).toBe(0);
        expect(await shell.locator("textarea").count()).toBe(0);
        if (!(await progress.evaluate((element) => element.hasAttribute("open")))) {
          await progress.locator("summary").click();
        }
        if (proofDir) {
          const frame = await takeControlUiScreenshotFrame(
            page,
            pane,
            [details, progress, notice],
            {
              animations: "disabled",
            },
          );
          await writeFile(path.join(proofDir, `subagent-${width}.png`), frame.png);
        }
        await expect
          .poll(() =>
            details.evaluate((element) => {
              const bounds = element.getBoundingClientRect();
              const footer = element
                .closest("openclaw-chat-pane")!
                .querySelector(".agent-chat__disabled-banner--replacement")!
                .getBoundingClientRect();
              return (
                bounds.height > 0 && bounds.bottom <= footer.top + 1 && footer.bottom <= innerHeight
              );
            }),
          )
          .toBe(true);
        expect(await details.evaluate((element) => getComputedStyle(element).overflowY)).toBe(
          "auto",
        );
        expect(
          await details.evaluate((element) => element.scrollHeight > element.clientHeight),
        ).toBe(true);
        const footerTop = await notice.evaluate((element) => element.getBoundingClientRect().top);
        await details.hover();
        await page.mouse.wheel(0, 1000);
        await expect
          .poll(() => details.evaluate((element) => element.scrollTop))
          .toBeGreaterThan(0);
        expect(await notice.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(
          footerTop,
          0,
        );
        await notice.getByRole("button", { name: "Open parent session", exact: true }).click({
          trial: true,
        });
        await progress.locator("summary").click();
        await expect.poll(() => progress.getAttribute("open")).toBeNull();
        await notice.getByRole("button", { name: "Open parent session", exact: true }).click();
        const input = shell.locator(".agent-chat__input");
        await input.locator("textarea").fill("Continue the review");
        await openChatDetails(pane);
        await progress.waitFor();
        expect(await input.locator("textarea").inputValue()).toBe("Continue the review");
        await expect
          .poll(() =>
            input.evaluate((element) => {
              const inputBounds = element.getBoundingClientRect();
              const detailsBounds = element
                .closest("openclaw-chat-pane")!
                .querySelector(".chat-details")!
                .getBoundingClientRect();
              return (
                detailsBounds.height > 0 &&
                detailsBounds.bottom <= inputBounds.top &&
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
