import { expect, it } from "vitest";
import {
  controlUiSessionUrl,
  installMockGateway,
  pauseVirtualClock,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Chat loading deadlines" });
const draft = "Keep this draft until I choose to send it.";
const readyText = "The conversation is ready.";

suite.define(() => {
  it.each(["chat.startup", "models.list"] as const)(
    "settles a silent %s read and preserves the draft through recovery",
    async (method) => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
        async ({ page }) => {
          const submittedMessage = "Send this when the conversation recovers.";
          await page.clock.install();
          if (method === "models.list") {
            await page.addInitScript(() => {
              const gateway = location.origin.replace(/^http/, "ws");
              localStorage.setItem(
                `openclaw.new-session.preferences.v1:${gateway}`,
                JSON.stringify({ agents: { main: { model: "openai/gpt-5.5" } } }),
              );
            });
          }
          const gateway = await installMockGateway(page, {
            sessionKey: "agent:main:main",
            heldMethods: [method],
            historyMessages: [{ role: "assistant", content: readyText }],
          });
          await page.goto(
            new URL(method === "models.list" ? "/new" : "/chat/main", suite.server.baseUrl).href,
          );
          await gateway.waitForRequest(method);
          const composer = page.locator("textarea:visible").first();
          if (method === "chat.startup") {
            await composer.fill(submittedMessage);
            await page.getByRole("button", { name: "Send message", exact: true }).click();
            await expect.poll(() => composer.inputValue()).toBe("");
            await page
              .locator(".chat-queue")
              .getByText(submittedMessage, { exact: true })
              .waitFor();
            expect(await gateway.getRequests("chat.send")).toHaveLength(0);
          }
          await composer.fill(draft);
          await pauseVirtualClock(page);
          await page.clock.runFor(60_001);

          expect(await gateway.getSocketCount()).toBe(1);
          expect(await composer.inputValue()).toBe(draft);
          if (method === "chat.startup") {
            expect(await page.locator(".chat-history-error").textContent()).toContain("timed out");
            expect(await page.getByRole("button", { name: "Retry", exact: true }).isEnabled()).toBe(
              true,
            );
            expect(
              await page.getByRole("button", { name: "Loading chat", exact: true }).count(),
            ).toBe(0);
            const send = page.locator(".chat-send-btn--send");
            expect(await send.isEnabled()).toBe(true);
            expect(await send.getAttribute("aria-busy")).toBe("false");
            expect(await gateway.getRequests("chat.send")).toHaveLength(0);
            expect(
              await page
                .locator(".chat-queue")
                .getByText(submittedMessage, { exact: true })
                .count(),
            ).toBe(1);
          } else {
            expect(await page.locator('[data-chat-model-select="true"]').textContent()).toContain(
              "Models unavailable",
            );
            expect(
              await page
                .getByRole("button", { name: "Start session", exact: true })
                .getAttribute("aria-disabled"),
            ).toBe("false");
          }

          await gateway.resolveDeferred(method);
          await page.clock.runFor(1);
          if (method === "chat.startup") {
            expect(await page.getByText(readyText, { exact: true }).count()).toBe(0);
            expect(await gateway.getRequests("chat.send")).toHaveLength(0);
            expect(await composer.inputValue()).toBe(draft);
            await page.getByRole("button", { name: "Retry", exact: true }).click();
          } else {
            expect(await page.locator('[data-chat-model-select="true"]').textContent()).toContain(
              "Models unavailable",
            );
            await page.locator('[data-chat-model-select="true"]').click();
          }
          await page.clock.runFor(100);
          await expect.poll(async () => (await gateway.getRequests(method)).length).toBe(2);
          if (method === "chat.startup") {
            await page.getByText(readyText, { exact: true }).waitFor();
            const sent = await gateway.waitForRequest("chat.send");
            expect(sent.params).toMatchObject({
              sessionKey: "agent:main:main",
              sessionId: "session:agent:main:main",
              message: submittedMessage,
            });
            expect(await gateway.getRequests("chat.send")).toHaveLength(1);
            expect(await page.locator(".chat-send-btn--send").isEnabled()).toBe(true);
          } else {
            expect(
              await page.locator('[data-chat-model-select="true"]').textContent(),
            ).not.toContain("Models unavailable");
          }
          expect(await composer.inputValue()).toBe(draft);
        },
      );
    },
  );
  it.each(["before history", "after history"] as const)(
    "accepts an explicit failed-session retry %s and sends it once history is ready",
    async (retryTiming) => {
      await suite.withPage({}, async ({ page: currentPage }) => {
        const sessionKey = "agent:main:main";
        const diagnostic = "⚠️ ✉️ Message failed: delivery unavailable near 🧭";
        const renderedDiagnostic = "Message failed: delivery unavailable near 🧭";
        const gateway = await installMockGateway(currentPage, {
          sessionKey,
          // Account recovery can replace startup with a scoped history request.
          heldMethods: ["chat.startup", "chat.history", "chat.send"],
          sessions: [
            {
              key: sessionKey,
              status: "failed",
              hasActiveRun: false,
              lastRunId: "failed-run",
              lastRunError: diagnostic,
            },
          ],
        });
        await currentPage.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await gateway.waitForRequest("sessions.list", { match: { includeGlobal: true } });
        const startup = await gateway.waitForRequest("chat.startup");
        expect(startup.params).toMatchObject({ sessionKey });
        const composer = currentPage.locator(".agent-chat__input textarea");
        const sendButton = currentPage.getByRole("button", { name: "Send message" });
        const alert = currentPage.getByRole("alert").filter({ hasText: renderedDiagnostic });
        await composer.fill("Try again");
        expect(await sendButton.isEnabled()).toBe(true);
        if (retryTiming === "before history") {
          await sendButton.click();
          await expect.poll(() => composer.inputValue()).toBe("");
          await currentPage
            .locator(".chat-queue")
            .getByText("Try again", { exact: true })
            .waitFor();
        }
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);

        // Fault injection controls only WebSocket delivery, never application state.
        await gateway.resolveDeferred("chat.startup");
        await expect
          .poll(
            async () =>
              (await gateway.getRequests("chat.history")).length > 0 ||
              (retryTiming === "before history"
                ? (await gateway.getRequests("chat.send")).length > 0
                : (await alert.count()) > 0),
          )
          .toBe(true);
        if ((await gateway.getRequests("chat.history")).length > 0) {
          await gateway.resolveDeferred("chat.history");
        }
        if (retryTiming === "after history") {
          expect(await composer.inputValue()).toBe("Try again");
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
          await alert.waitFor();
          await alert
            .locator(".chat-error__content > strong")
            .getByText(renderedDiagnostic)
            .waitFor();
          expect(await alert.locator("details").count()).toBe(0);
          await sendButton.click();
        }
        const send = await gateway.waitForRequest("chat.send");
        expect(send.params).toMatchObject({ sessionKey, message: "Try again" });
        const { idempotencyKey: runId } = send.params as { idempotencyKey: string };
        expect(runId).toEqual(expect.any(String));
        expect(await gateway.getRequests("chat.send")).toHaveLength(1);
        expect(await composer.inputValue()).toBe("");
        if (retryTiming === "after history") {
          await expect.poll(() => alert.count()).toBe(0);
        }
        await gateway.resolveDeferred("chat.send", { runId, status: "started" });
        await currentPage.getByRole("button", { name: "Stop generating" }).waitFor();
        await expect.poll(() => alert.count()).toBe(0);
        await gateway.emitChatFinal({ sessionKey, runId, text: "Recovery completed." });
        await currentPage
          .locator(".chat-group.assistant")
          .getByText("Recovery completed.", { exact: true })
          .waitFor();
        await expect.poll(() => alert.count()).toBe(0);
        expect(await currentPage.getByRole("button", { name: "Stop generating" }).count()).toBe(0);
        expect(await gateway.getRequests("chat.send")).toHaveLength(1);
      });
    },
  );
});
