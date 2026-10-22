import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "side-chat message footer" });
const question = "Which repos did the session touch?";
const answer =
  "Not just OpenClaw: the session also accessed the Hermit repo. It did not have ClawHub's source checked out.";

suite.define(() => {
  it("renders Side chat answers with the main chat's message footer", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 900 }, locale: "en-US" },
      async ({ page }) => {
        const sessionKey = "agent:main:side-chat-footer";
        const ts = Date.now() - 5 * 60_000;
        await installMockGateway(page, {
          sessionKey,
          historyMessages: [
            { role: "user", content: question, timestamp: ts - 1_000 },
            { role: "assistant", content: answer, timestamp: ts },
          ],
          methodResponses: {
            "sessions.companion.state": { exchanges: [{ question, answer, ts }] },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const main = page.locator(".chat-thread");
        await main.getByText(answer).waitFor();
        await openChatSidePanelType(page, "Side chat");
        const side = page.locator("openclaw-chat-session-rail");
        await side.getByText(answer).waitFor();
        const mainFooter = main.locator(".chat-group.assistant .chat-group-footer").last();
        const sideFooter = side.locator(".chat-group.assistant .chat-group-footer").last();
        try {
          await sideFooter.waitFor({ timeout: 5_000 });
          // Same footer tree: identity, relative timestamp and message actions.
          const footerShape = (footer: typeof mainFooter) =>
            footer.evaluate((node) => ({
              meta: [...node.querySelectorAll(".chat-group-footer__meta > *")].map(
                (child) => child.className,
              ),
              time: node.querySelector("time.chat-group-timestamp")?.textContent,
              actions: [...node.querySelectorAll(".chat-group-footer-actions button")].map(
                (button) => button.getAttribute("aria-label"),
              ),
            }));
          const mainShape = await footerShape(mainFooter);
          // Side chat exchanges have no reply target; every other footer part is shared.
          expect(await footerShape(sideFooter)).toEqual({
            ...mainShape,
            actions: mainShape.actions.filter((label) => label !== "Reply to message"),
          });
          expect(mainShape.time).toBeTruthy();
          expect(await side.getByText(/^as of /).count()).toBe(0);
          // The panel has no avatar gutter: the answer starts at the exchange edge.
          const inset = await side
            .locator(".chat-session-rail__exchange")
            .last()
            .evaluate((exchange) => {
              const messages = exchange.querySelector(".chat-group.assistant .chat-group-messages");
              return messages!.getBoundingClientRect().left - exchange.getBoundingClientRect().left;
            });
          expect(Math.abs(inset)).toBeLessThanOrEqual(1);
        } finally {
          if (process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR) {
            // Footers are hover-disclosed in both surfaces; capture each revealed.
            for (const [name, surface] of [
              ["main", main],
              ["side", side],
            ] as const) {
              await surface.getByText(answer).hover();
              const frame = await takeControlUiScreenshotFrame(
                page,
                page.locator("body"),
                [main.getByText(answer), side.getByText(answer)],
                { animations: "disabled" },
              );
              await writeFile(path.join(suite.artifactDir, `hover-${name}.png`), frame.png);
            }
          }
        }
      },
    );
  });
});
