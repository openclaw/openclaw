import { expect, it } from "vitest";
import {
  controlUiSessionUrl,
  defaultControlUiFeatureMethods,
  installMockGateway,
  pauseVirtualClock,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Chat loading deadlines" });
const draft = "Keep this draft until I choose to send it.";
const readyText = "The conversation is ready.";
const startupSessionKey = "agent:main:startup-conversation";
const startupPath = "/chat/main/startup-conversation";

suite.define(() => {
  it("automatically loads the route and sidebar after prolonged agent startup", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        await page.clock.install();
        const gateway = await installMockGateway(page, {
          startupPendingResponses: 20,
          featureMethods: [...defaultControlUiFeatureMethods, "sessions.catalog.list"],
          methodResponses: { "sessions.catalog.list": { catalogs: [] } },
          sessionKey: startupSessionKey,
          historyMessages: [{ role: "assistant", content: readyText }],
          sessions: [
            { key: "agent:main:main", label: "Main" },
            { key: startupSessionKey, label: "Startup conversation" },
          ],
        });
        await page.goto(new URL(startupPath, suite.server.baseUrl).href);
        const startup = page.locator(".agent-startup-state");
        await startup.waitFor();
        const sidebar = page.locator("openclaw-app-sidebar");
        await sidebar.getByRole("status").filter({ hasText: "Starting up" }).waitFor();
        await pauseVirtualClock(page);
        expect(await startup.getAttribute("role")).toBe("status");
        expect(await startup.getAttribute("aria-live")).toBe("polite");
        expect(await startup.textContent()).toContain("Starting up");
        expect(await startup.textContent()).toContain("This view will load automatically.");
        expect(await startup.getByRole("button").count()).toBe(0);
        expect(await page.getByText("Panel failed to load", { exact: true }).count()).toBe(0);
        expect(await sidebar.locator(".callout.danger").count()).toBe(0);
        expect(await sidebar.locator(".sidebar-session-catalog-error").count()).toBe(0);
        expect(await page.locator("body").textContent()).not.toContain("openclaw doctor --fix");

        await page.clock.runFor(60_001);
        expect(await startup.isVisible()).toBe(true);
        expect((await gateway.getRequests("sessions.resolve")).length).toBeGreaterThan(1);
        expect((await gateway.getRequests("sessions.list")).length).toBeGreaterThan(1);
        expect(await sidebar.locator(".callout.danger").count()).toBe(0);
        expect(await sidebar.locator(".sidebar-session-catalog-error").count()).toBe(0);

        await page.clock.runFor(150_000);
        await page.getByText(readyText, { exact: true }).waitFor();
        await sidebar.locator(`[data-session-key="${startupSessionKey}"]`).waitFor();
        expect(await startup.count()).toBe(0);
        expect(await sidebar.getByRole("status").filter({ hasText: "Starting up" }).count()).toBe(
          0,
        );
        expect(await sidebar.locator(".callout.danger").count()).toBe(0);
        expect(await sidebar.locator(".sidebar-session-catalog-error").count()).toBe(0);
        expect((await gateway.getRequests("sessions.catalog.list")).length).toBeGreaterThan(20);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      },
    );
  });

  it("shows a real inspection failure after pending startup", async () => {
    await suite.withPage({}, async ({ page }) => {
      await page.clock.install();
      const diagnostic = "Agent main database inspection failed. Run openclaw doctor --fix.";
      const failure = {
        __mockError: {
          code: "UNAVAILABLE",
          retryable: false,
          message: diagnostic,
          details: { code: "agent-database-inspection-failed", agentId: "main" },
        },
      };
      const gateway = await installMockGateway(page, {
        startupPendingResponses: 20,
        featureMethods: [...defaultControlUiFeatureMethods, "sessions.catalog.list"],
        sessionKey: startupSessionKey,
        methodResponses: {
          "sessions.resolve": failure,
          "sessions.describe": failure,
          "sessions.list": failure,
          "sessions.catalog.list": failure,
        },
      });
      await page.goto(new URL(startupPath, suite.server.baseUrl).href);
      await page.locator(".agent-startup-state").waitFor();
      await pauseVirtualClock(page);
      await page.clock.runFor(150_000);

      await page.getByText("Panel failed to load", { exact: true }).waitFor();
      expect(await page.locator(".agent-startup-state").count()).toBe(0);
      expect(await page.getByRole("button", { name: "Retry", exact: true }).isEnabled()).toBe(true);
      const sidebar = page.locator("openclaw-app-sidebar");
      await sidebar
        .locator(".callout.danger, .sidebar-session-catalog-error")
        .filter({ hasText: diagnostic })
        .first()
        .waitFor();
      const attempts = (await gateway.getRequests("sessions.resolve")).length;
      await page.clock.runFor(30_000);
      expect(await gateway.getRequests("sessions.resolve")).toHaveLength(attempts);
    });
  });

  it("cancels route startup retries when navigating away", async () => {
    await suite.withPage({}, async ({ page }) => {
      await page.clock.install();
      const gateway = await installMockGateway(page, {
        startupPendingResponses: 100,
        sessionKey: startupSessionKey,
      });
      await page.goto(new URL(startupPath, suite.server.baseUrl).href);
      await page.locator(".agent-startup-state").waitFor();
      await page.locator(".sidebar-new-session").first().click();
      await page.locator("textarea:visible").first().waitFor();
      expect(new URL(page.url()).pathname).toBe("/new");
      await pauseVirtualClock(page);
      const attempts = (await gateway.getRequests("sessions.resolve")).length;
      await page.clock.runFor(30_000);
      expect(await gateway.getRequests("sessions.resolve")).toHaveLength(attempts);
      expect(await page.locator(".agent-startup-state").count()).toBe(0);
      expect(await page.locator("body").textContent()).not.toContain("openclaw doctor --fix");
    });
  });

  it("presents pending agent database inspection as retryable startup", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        await page.clock.install();
        const diagnostic =
          "Agent main has not completed startup inspection and preparation. Run Doctor if inspection cannot complete.";
        const gateway = await installMockGateway(page, {
          awaitInitialRoster: false,
          sessionKey: "agent:main:main",
          methodResponses: {
            "chat.startup": {
              __mockError: {
                code: "UNAVAILABLE",
                message: diagnostic,
                details: {
                  agentId: "main",
                  paths: ["/private/state/agents/main/openclaw-agent.sqlite"],
                  code: "agent-database-inspection-pending",
                  reason: "Agent main has not completed startup inspection and preparation.",
                  repairHint: "Run Doctor if inspection cannot complete.",
                },
                retryable: true,
                retryAfterMs: 250,
              },
            },
          },
        });
        await page.goto(new URL("/chat/main", suite.server.baseUrl).href);
        await gateway.waitForRequest("chat.startup");
        await pauseVirtualClock(page);
        await page.clock.runFor(60_001);

        const notice = page.locator(".chat-history-error");
        await notice.waitFor();
        expect(await notice.textContent()).toContain(
          "This agent is still starting. Retry in a moment.",
        );
        expect(await notice.textContent()).not.toContain(diagnostic);
        expect(await page.getByRole("button", { name: "Retry", exact: true }).isEnabled()).toBe(
          true,
        );
      },
    );
  });

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
            // A saved explicit choice needs a receipt; empty automatic drafts remain Gateway-owned.
            expect(
              await page
                .getByRole("button", { name: "Start session", exact: true })
                .getAttribute("aria-disabled"),
            ).toBe("true");
            await composer.press("Enter");
            expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
          }

          const attemptsBeforeRetry = method === "chat.startup" ? 2 : 1;
          expect(await gateway.getRequests(method)).toHaveLength(attemptsBeforeRetry);
          await gateway.resolveDeferred(method);
          await page.clock.runFor(1);
          if (method === "chat.startup") {
            expect(await page.getByText(readyText, { exact: true }).count()).toBe(0);
            expect(await gateway.getRequests("chat.send")).toHaveLength(0);
            expect(await composer.inputValue()).toBe(draft);
            await page.clock.resume();
            await page.getByRole("button", { name: "Retry", exact: true }).click();
          } else {
            expect(await page.locator('[data-chat-model-select="true"]').textContent()).toContain(
              "Models unavailable",
            );
            expect(
              await page
                .getByRole("button", { name: "Start session", exact: true })
                .getAttribute("aria-disabled"),
            ).toBe("true");
            expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
            await page.clock.resume();
            await page.locator('[data-chat-model-select="true"]').click();
          }
          await expect
            .poll(async () => (await gateway.getRequests(method)).length)
            .toBe(attemptsBeforeRetry + 1);
          // The native details toggle may send the retry after the click resolves.
          // Advance its mock response timer only after that request is observed.
          await page.clock.runFor(100);
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
            await page
              .locator('[data-chat-model-option="openai/gpt-5.5"]')
              .waitFor({ state: "attached" });
            expect(
              await page.locator('[data-chat-model-select="true"]').textContent(),
            ).not.toContain("Models unavailable");
            expect(
              await page
                .getByRole("button", { name: "Start session", exact: true })
                .getAttribute("aria-disabled"),
            ).toBe("false");
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
            .locator("summary strong")
            .getByText("Couldn't finish this reply. Check the conversation before trying again.")
            .waitFor();
          expect(await alert.locator("details").getAttribute("open")).toBeNull();
          await alert.locator("summary").click();
          await alert.getByLabel("Error details", { exact: true }).waitFor();
          expect(await alert.getByLabel("Error details", { exact: true }).textContent()).toContain(
            renderedDiagnostic,
          );
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
