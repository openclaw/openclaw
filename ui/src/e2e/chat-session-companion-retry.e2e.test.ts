import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "session companion retry" });

suite.define(() => {
  it.each(["side-composer", "/btw", "/side"] as const)(
    "keeps failed turns in order and retries the selected question from %s",
    async (entry) => {
      await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
        const sessionKey = "agent:main:companion-retry";
        const mainAnswer = "The main conversation must remain visible.";
        const sideAnswer = "The earlier side answer must remain visible.";
        const question = "What should happen next?";
        const followup = "What should I verify?";
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
                message: "Session history is unavailable.",
                retryable: true,
                details: { reason: "context-unavailable" },
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
          entry === "side-composer"
            ? side.getByRole("textbox")
            : page.getByRole("textbox", { name: "Chat composer", exact: true });
        const send = async (text: string) => {
          await composer.fill(entry === "side-composer" ? text : `${entry} ${text}`);
          await composer.press("Enter");
        };
        const questions = async () =>
          (await side.locator(".chat-session-rail__question").allTextContents()).map((text) =>
            text.trim(),
          );
        await send(question);
        await side.locator(".chat-session-rail__exchange--error").waitFor();
        await gateway.deferNext("sessions.companion.ask");
        await send(followup);
        await side.locator(".chat-session-rail__exchange--pending").waitFor();
        expect(await questions()).toEqual(["What changed?", question, followup]);
        expect(await side.locator(".chat-session-rail__retry").isDisabled()).toBe(true);
        await gateway.rejectDeferred("sessions.companion.ask", {
          code: "UNAVAILABLE",
          message: "Side chat timed out.",
          retryable: true,
        });
        await expect
          .poll(async () => side.locator(".chat-session-rail__exchange--error").count())
          .toBe(2);
        await gateway.deferNext("sessions.companion.ask");
        await side.locator(".chat-session-rail__retry").first().click();
        await side.locator(".chat-session-rail__exchange--pending").waitFor();
        expect(await questions()).toEqual(["What changed?", question, followup]);
        expect(
          await side
            .locator(".chat-session-rail__exchange--pending .chat-session-rail__question")
            .textContent(),
        ).toContain(question);
        await gateway.resolveDeferred("sessions.companion.ask", {
          answer: "Retry recovered the answer.",
          ts: 2000,
        });
        await side.getByText("Retry recovered the answer.", { exact: true }).waitFor();
        expect(await questions()).toEqual(["What changed?", question, followup]);
        expect(
          await side
            .locator(".chat-session-rail__exchange--error .chat-session-rail__question")
            .textContent(),
        ).toContain(followup);
        expect(await page.getByText(mainAnswer, { exact: true }).isVisible()).toBe(true);
        expect(await side.getByText(sideAnswer, { exact: true }).isVisible()).toBe(true);
        expect(
          (await gateway.getRequests("sessions.companion.ask")).map((request) => request.params),
        ).toEqual([
          { sessionKey, agentId: "main", question },
          { sessionKey, agentId: "main", question: followup },
          { sessionKey, agentId: "main", question },
        ]);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        expect(await gateway.getRequests("sessions.reset")).toHaveLength(0);
        expect(await gateway.getRequests("sessions.companion.reset")).toHaveLength(0);
        expect(errors).toEqual([]);
      });
    },
  );
});
