import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "session companion retry" });

suite.define(() => {
  it.each(["side-composer", "main-command", "new-question"] as const)(
    "keeps both conversations visible when retrying from $0",
    async (entry) => {
      await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
        const sessionKey = "agent:main:companion-retry";
        const mainAnswer = "The main conversation must remain visible.";
        const sideAnswer = "The earlier side answer must remain visible.";
        const question = "What should happen next?";
        const gateway = await installMockGateway(page, {
          sessionKey,
          historyMessages: [
            { role: "user", content: "Investigate the menu loading." },
            { role: "assistant", content: mainAnswer },
          ],
          methodResponses: {
            "sessions.companion.state": {
              exchanges: [{ question: "What changed?", answer: sideAnswer, ts: 1000 }],
            },
            "sessions.companion.ask": {
              __mockError: {
                code: "UNAVAILABLE",
                message:
                  entry === "new-question"
                    ? "Side chat timed out."
                    : "Session history is unavailable.",
                retryable: entry !== "new-question",
                details: {
                  reason: entry === "new-question" ? "unavailable" : "context-unavailable",
                },
              },
            },
          },
        });
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await page.getByText(mainAnswer, { exact: true }).waitFor();
        await openChatSidePanelType(page, "Side chat");
        const side = page.locator("openclaw-chat-session-rail");
        await side.getByText(sideAnswer, { exact: true }).waitFor();
        const composer =
          entry !== "main-command"
            ? side.getByRole("textbox")
            : page.getByRole("textbox", { name: "Chat composer", exact: true });
        await composer.fill(entry === "main-command" ? `/btw ${question}` : question);
        await composer.press("Enter");
        const retry = side.locator(".chat-session-rail__retry");
        await side.locator(".chat-session-rail__exchange--error").waitFor();
        if (entry !== "new-question") {
          await retry.waitFor();
        }
        const artifactDir = createControlUiE2eArtifactDir("companion-retry");
        await page.screenshot({ path: path.join(artifactDir, "failed-question.png") });
        expect(await page.getByText(mainAnswer, { exact: true }).isVisible()).toBe(true);
        expect(await side.getByText(sideAnswer, { exact: true }).isVisible()).toBe(true);
        await gateway.deferNext("sessions.companion.ask");
        if (entry === "new-question") {
          await side.getByRole("textbox").fill("retry");
          await side.getByRole("textbox").press("Enter");
        } else {
          await retry.click();
        }
        await expect
          .poll(async () => (await gateway.getRequests("sessions.companion.ask")).length)
          .toBe(2);
        const retriedQuestion = entry === "new-question" ? "retry" : question;
        expect((await gateway.getRequests("sessions.companion.ask"))[1]).toMatchObject({
          params: { question: retriedQuestion },
        });
        expect(await side.getByText(retriedQuestion, { exact: true }).count()).toBe(1);
        await page.screenshot({ path: path.join(artifactDir, "retry-pending.png") });
        expect(await page.getByText(mainAnswer, { exact: true }).isVisible()).toBe(true);
        expect(await side.getByText(sideAnswer, { exact: true }).isVisible()).toBe(true);
        expect(await side.locator(".chat-session-rail__exchange--pending").textContent()).toContain(
          entry === "new-question" ? "retry" : question,
        );
        if (entry === "new-question") {
          expect(await side.getByText(question, { exact: true }).count()).toBe(1);
        }
        await gateway.rejectDeferred("sessions.companion.ask", {
          code: "UNAVAILABLE",
          message: "Side chat timed out.",
          retryable: true,
        });
        await retry.waitFor();
        expect(await page.getByText(mainAnswer, { exact: true }).isVisible()).toBe(true);
        expect(await side.getByText(sideAnswer, { exact: true }).isVisible()).toBe(true);
        await gateway.setMethodResponse("sessions.companion.ask", {
          answer: "Retry recovered the answer.",
          ts: 2000,
        });
        await retry.click();
        await side.getByText("Retry recovered the answer.", { exact: true }).waitFor();
        expect(await gateway.getRequests("sessions.companion.ask")).toMatchObject([
          { params: { question } },
          { params: { question: retriedQuestion } },
          { params: { question: retriedQuestion } },
        ]);
        expect(await side.getByText(retriedQuestion, { exact: true }).count()).toBe(1);
        await page.screenshot({ path: path.join(artifactDir, "retry-recovered.png") });
        expect(await page.getByText(mainAnswer, { exact: true }).isVisible()).toBe(true);
        expect(await side.getByText(sideAnswer, { exact: true }).isVisible()).toBe(true);
        if (entry === "new-question") {
          expect(await side.getByText(question, { exact: true }).count()).toBe(1);
        }
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        expect(await gateway.getRequests("sessions.reset")).toHaveLength(0);
        expect(await gateway.getRequests("sessions.companion.reset")).toHaveLength(0);
        expect(errors).toEqual([]);
      });
    },
  );
});
