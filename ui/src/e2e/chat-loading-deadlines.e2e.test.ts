import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  pauseVirtualClock,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Chat loading deadlines" });
const draft = "Keep this draft until I choose to send it.";
const readyText = "The conversation is ready.";
const startupSessionKey = "agent:main:startup-conversation";
const startupPath = "/chat/main/startup-conversation";

const withPage = (run: (page: Page) => Promise<void>) =>
  suite.withPage(createControlUiE2eContextOptions(), ({ page }) => run(page));

async function startPending(page: Page, options: Parameters<typeof installMockGateway>[1]) {
  await page.clock.install();
  const gateway = await installMockGateway(page, {
    sessionKey: startupSessionKey,
    startupPendingResponses: 20,
    ...options,
  });
  await page.goto(new URL(startupPath, suite.server.baseUrl).href);
  const startup = page.locator(".agent-startup-state");
  await startup.waitFor();
  return { gateway, startup, sidebar: page.locator("openclaw-app-sidebar") };
}
const catalogMethods = [...defaultControlUiFeatureMethods, "sessions.catalog.list"];
const sidebarErrors = ".callout.danger, .sidebar-session-catalog-error";

suite.define(() => {
  it("automatically loads the route and sidebar after prolonged agent startup", async () => {
    await withPage(async (page) => {
      const { gateway, startup, sidebar } = await startPending(page, {
        featureMethods: catalogMethods,
        methodResponses: { "sessions.catalog.list": { catalogs: [] } },
        historyMessages: [{ role: "assistant", content: readyText }],
        sessions: [
          { key: "agent:main:main", label: "Main" },
          { key: startupSessionKey, label: "Startup conversation" },
        ],
      });
      await sidebar.getByRole("status").filter({ hasText: "Starting up" }).waitFor();
      await pauseVirtualClock(page);
      expect(await startup.getAttribute("role")).toBe("status");
      expect(await startup.getAttribute("aria-live")).toBe("polite");
      expect(await startup.textContent()).toContain("Starting up");
      expect(await startup.textContent()).toContain("This view will load automatically.");
      expect(await startup.getByRole("button").count()).toBe(0);
      expect(await page.getByText("Panel failed to load", { exact: true }).count()).toBe(0);
      expect(await sidebar.locator(sidebarErrors).count()).toBe(0);
      expect(await page.locator("body").textContent()).not.toContain("openclaw doctor --fix");

      await page.clock.runFor(60_001);
      expect(await startup.isVisible()).toBe(true);
      expect((await gateway.getRequests("sessions.resolve")).length).toBeGreaterThan(1);
      expect((await gateway.getRequests("sessions.list")).length).toBeGreaterThan(1);
      expect(await sidebar.locator(sidebarErrors).count()).toBe(0);

      await page.clock.runFor(150_000);
      await page.getByText(readyText, { exact: true }).waitFor();
      await sidebar.locator(`[data-session-key="${startupSessionKey}"]`).waitFor();
      expect(await startup.count()).toBe(0);
      expect(await sidebar.getByRole("status").filter({ hasText: "Starting up" }).count()).toBe(0);
      expect(await sidebar.locator(sidebarErrors).count()).toBe(0);
      expect((await gateway.getRequests("sessions.catalog.list")).length).toBeGreaterThan(20);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    });
  });

  it("shows a real inspection failure after pending startup", async () => {
    await suite.withPage({}, async ({ page }) => {
      const diagnostic = "Agent main database inspection failed. Run openclaw doctor --fix.";
      const failure = {
        __mockError: {
          code: "UNAVAILABLE",
          retryable: false,
          message: diagnostic,
          details: { code: "agent-database-inspection-failed", agentId: "main" },
        },
      };
      const { gateway, startup, sidebar } = await startPending(page, {
        featureMethods: catalogMethods,
        methodResponses: {
          "sessions.resolve": failure,
          "sessions.describe": failure,
          "sessions.list": failure,
          "sessions.catalog.list": failure,
        },
      });
      await pauseVirtualClock(page);
      await page.clock.runFor(150_000);

      await page.getByText("Panel failed to load", { exact: true }).waitFor();
      expect(await startup.count()).toBe(0);
      expect(await page.getByRole("button", { name: "Retry", exact: true }).isEnabled()).toBe(true);
      await sidebar.locator(sidebarErrors).filter({ hasText: diagnostic }).first().waitFor();
      const attempts = (await gateway.getRequests("sessions.resolve")).length;
      await page.clock.runFor(30_000);
      expect(await gateway.getRequests("sessions.resolve")).toHaveLength(attempts);
    });
  });

  it("cancels route startup retries when navigating away", async () => {
    await suite.withPage({}, async ({ page }) => {
      const { gateway, startup } = await startPending(page, { startupPendingResponses: 100 });
      await page.locator(".sidebar-new-session").first().click();
      await page.locator("textarea:visible").first().waitFor();
      expect(new URL(page.url()).pathname).toBe("/new");
      await pauseVirtualClock(page);
      const attempts = (await gateway.getRequests("sessions.resolve")).length;
      await page.clock.runFor(30_000);
      expect(await gateway.getRequests("sessions.resolve")).toHaveLength(attempts);
      expect(await startup.count()).toBe(0);
      expect(await page.locator("body").textContent()).not.toContain("openclaw doctor --fix");
    });
  });

  it("presents pending agent database inspection as retryable startup", async () => {
    await withPage(async (page) => {
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
      expect(await notice.locator("p").textContent()).toContain(
        "This agent is still starting. Retry in a moment.",
      );
      expect(await notice.textContent()).not.toContain(diagnostic);
      expect(await page.getByRole("button", { name: "Retry", exact: true }).isEnabled()).toBe(true);
    });
  });

  it("settles a silent model read and preserves the draft through recovery", async () => {
    await withPage(async (page) => {
      await page.clock.install();
      await page.addInitScript(() => {
        const gateway = location.origin.replace(/^http/, "ws");
        localStorage.setItem(
          `openclaw.new-session.preferences.v1:${gateway}`,
          JSON.stringify({ agents: { main: { model: "openai/gpt-5.5" } } }),
        );
      });
      const gateway = await installMockGateway(page, {
        sessionKey: "agent:main:main",
        heldMethods: ["models.list"],
      });
      await page.goto(new URL("/new", suite.server.baseUrl).href);
      await gateway.waitForRequest("models.list");
      const composer = page.locator("textarea:visible").first();
      const modelSelect = page.locator('[data-chat-model-select="true"]');
      const start = page.getByRole("button", { name: "Start session", exact: true });
      await composer.fill(draft);
      await pauseVirtualClock(page);
      await page.clock.runFor(60_001);
      expect(await gateway.getSocketCount()).toBe(1);
      expect(await composer.inputValue()).toBe(draft);
      expect(await modelSelect.textContent()).toContain("Models unavailable");
      expect(await start.getAttribute("aria-disabled")).toBe("true");
      await composer.press("Enter");
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
      expect(await gateway.getRequests("models.list")).toHaveLength(1);
      await gateway.resolveDeferred("models.list");
      await page.clock.runFor(1);
      expect(await modelSelect.textContent()).toContain("Models unavailable");
      expect(await start.getAttribute("aria-disabled")).toBe("true");
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
      await page.clock.resume();
      await modelSelect.click();
      await expect.poll(async () => (await gateway.getRequests("models.list")).length).toBe(2);
      // Observe the native details retry before advancing its mock response timer.
      await page.clock.runFor(100);
      await page
        .locator('[data-chat-model-option="openai/gpt-5.5"]')
        .waitFor({ state: "attached" });
      expect(await modelSelect.textContent()).not.toContain("Models unavailable");
      expect(await start.getAttribute("aria-disabled")).toBe("false");
      expect(await composer.inputValue()).toBe(draft);
    });
  });

  it("sends from an existing chat while models.list never answers", async () => {
    await withPage(async (page) => {
      const gateway = await installMockGateway(page, {
        sessionKey: "agent:main:main",
        heldMethods: ["models.list"],
        historyMessages: [{ role: "assistant", content: readyText }],
      });
      await page.goto(new URL("/chat/main", suite.server.baseUrl).href);
      await gateway.waitForRequest("models.list");
      await page.getByText(readyText, { exact: true }).waitFor();
      const composer = page.locator("textarea:visible").first();
      await composer.fill(draft);
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      const sent = await gateway.waitForRequest("chat.send");
      expect(sent.params).toMatchObject({ sessionKey: "agent:main:main", message: draft });
      expect(await gateway.getRequests("models.list")).toHaveLength(1);
    });
  });
});
