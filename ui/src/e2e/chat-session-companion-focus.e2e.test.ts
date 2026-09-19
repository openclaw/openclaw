import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import {
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";
import { openSessionMenuSubmenu } from "./session-management.test-support.ts";

const suite = createControlUiE2eSuite({ name: "side-chat input focus" });

suite.define(() => {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    it(`focuses Side chat on open, reopen, and tab activation at ${viewport.width}px`, async () => {
      await suite.withPage({ viewport }, async ({ page }) => {
        await installMockGateway(page);
        await page.goto(`${suite.server.baseUrl}chat`);
        await openChatSidePanelType(page, "Side chat");
        const input = page.getByRole("textbox", { name: "Ask in side chat", exact: true });
        await expect
          .poll(() => input.evaluate((element) => document.activeElement === element))
          .toBe(true);
        await page.keyboard.type("Ready to ask");
        expect(await input.inputValue()).toBe("Ready to ask");

        await page.locator(".side-panel__minimize").click();
        await page.locator(".chat-side-panel-toggle").click();
        await expect
          .poll(() => input.evaluate((element) => document.activeElement === element))
          .toBe(true);
        expect(await input.inputValue()).toBe("Ready to ask");

        await openChatSidePanelType(page, "Tasks");
        await page.getByRole("tab", { name: "Side chat", exact: true }).click();
        await expect
          .poll(() => input.evaluate((element) => document.activeElement === element))
          .toBe(true);
        await page.keyboard.type(" again");
        expect(await input.inputValue()).toBe("Ready to ask again");
      });
    });
  }

  it.each(["/btw", "/side"])("opens and refocuses Side chat with %s", async (command) => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}chat`);
      const mainInput = page.locator(".agent-chat__composer-shell textarea");
      const input = page.getByRole("textbox", { name: "Ask in side chat", exact: true });
      expect(await input.isVisible()).toBe(false);
      for (const draft of ["", "Keep this side draft"]) {
        await mainInput.fill(command);
        await mainInput.press("Enter");
        await expect.poll(() => input.isVisible()).toBe(true);
        await expect
          .poll(() => input.evaluate((element) => document.activeElement === element))
          .toBe(true);
        expect(await mainInput.inputValue()).toBe("");
        expect(await input.inputValue()).toBe(draft);
        await page.keyboard.type("Keep this side draft");
      }
      await page.getByRole("button", { name: "Close Side chat", exact: true }).click();
      await openChatSidePanelType(page, "Side chat");
      await expect
        .poll(() => input.evaluate((element) => document.activeElement === element))
        .toBe(true);
      expect(await gateway.getRequests("sessions.companion.ask")).toHaveLength(0);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    });
  });

  it.each(["/btw", "/side"])(
    "preserves newer main focus while %s opens a delayed rail",
    async (command) => {
      await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
        const held = await holdModuleResponse(page, /\/assets\/chat-session-rail-[^/]+\.js$/u);
        try {
          await installMockGateway(page);
          await page.goto(`${suite.server.baseUrl}chat`);
          const mainInput = page.locator(".agent-chat__composer-shell textarea");
          await mainInput.fill(command);
          await mainInput.press("Enter");
          await held.request;
          const sideInput = page.getByRole("textbox", { name: "Ask in side chat", exact: true });
          expect(await sideInput.count()).toBe(0);
          expect(await mainInput.inputValue()).toBe("");
          await mainInput.click();
          held.release();
          await sideInput.waitFor();
          expect(await mainInput.evaluate((element) => document.activeElement === element)).toBe(
            true,
          );
          await page.keyboard.type("Keep typing here");
          expect(await mainInput.inputValue()).toBe("Keep typing here");
          expect(await sideInput.inputValue()).toBe("");
          await page.getByRole("button", { name: "Close Side chat", exact: true }).click();
          await openChatSidePanelType(page, "Side chat");
          await expect
            .poll(() => sideInput.evaluate((element) => document.activeElement === element))
            .toBe(true);
        } finally {
          held.release();
        }
      });
    },
  );

  it.each(["close", "minimize", "switch tabs"])(
    "focuses a new Side chat opening after %s supersedes an unmounted command",
    async (action) => {
      await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
        const held = await holdModuleResponse(page, /\/assets\/chat-session-rail-[^/]+\.js$/u);
        try {
          await installMockGateway(page);
          await page.goto(`${suite.server.baseUrl}chat`);
          const mainInput = page.locator(".agent-chat__composer-shell textarea");
          await mainInput.fill("/btw");
          await mainInput.press("Enter");
          await held.request;
          const sideInput = page.getByRole("textbox", { name: "Ask in side chat", exact: true });
          expect(await sideInput.count()).toBe(0);
          await page.getByRole("tab", { name: "Side chat", exact: true }).waitFor();
          if (action === "close") {
            await page.getByRole("button", { name: "Close Side chat", exact: true }).click();
          } else if (action === "minimize") {
            await page.locator(".side-panel__minimize").click();
          } else {
            await openChatSidePanelType(page, "Tasks");
          }
          held.release();
          if (action === "close") {
            await openChatSidePanelType(page, "Side chat");
          } else if (action === "minimize") {
            await page.locator(".chat-side-panel-toggle").click();
          } else {
            await page.getByRole("tab", { name: "Side chat", exact: true }).click();
          }
          await expect
            .poll(() => sideInput.evaluate((element) => document.activeElement === element))
            .toBe(true);
          await page.keyboard.type("New opening");
          expect(await sideInput.inputValue()).toBe("New opening");
        } finally {
          held.release();
        }
      });
    },
  );

  it("opens Side chat when selecting /btw from the slash menu", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}chat`);
      const mainInput = page.locator(".agent-chat__composer-shell textarea");
      await mainInput.fill("/bt");
      await page.getByRole("option").filter({ hasText: "/btw" }).click();
      const input = page.getByRole("textbox", { name: "Ask in side chat", exact: true });
      await expect
        .poll(() => input.evaluate((element) => document.activeElement === element))
        .toBe(true);
      expect(await mainInput.inputValue()).toBe("");
    });
  });

  it.each([false, true])(
    "submits a side question and focuses its composer with panel open=%s",
    async (open) => {
      await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          deferredMethods: ["sessions.companion.ask"],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const input = page.getByRole("textbox", { name: "Ask in side chat", exact: true });
        if (open) {
          await openChatSidePanelType(page, "Side chat");
          // Complete the opening's focus handoff before filling the main composer.
          await expect
            .poll(() => input.evaluate((element) => document.activeElement === element))
            .toBe(true);
        }
        const mainInput = page.locator(".agent-chat__composer-shell textarea");
        await mainInput.fill("/btw what is this?");
        await mainInput.press("Enter");
        const request = await gateway.waitForRequest("sessions.companion.ask");
        expect(request.params).toMatchObject({ question: "what is this?" });
        await expect.poll(() => input.isDisabled()).toBe(true);
        await gateway.resolveDeferred("sessions.companion.ask", {
          answer: "A side conversation.",
          ts: 1,
        });
        await page.getByText("A side conversation.", { exact: true }).waitFor();
        await expect
          .poll(() => input.evaluate((element) => document.activeElement === element))
          .toBe(true);
        expect(await mainInput.inputValue()).toBe("");
        await page.keyboard.type("Follow up");
        expect(await input.inputValue()).toBe("Follow up");
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      });
    },
  );

  it.each([false, true])(
    "cancels deferred side-chat focus after switching panes, returning=%s",
    async (returnToFirstPane) => {
      await suite.withPage({ viewport: { width: 2200, height: 1000 } }, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          deferredMethods: ["sessions.companion.ask"],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await page.getByRole("button", { name: "Open split view", exact: true }).click();
        const panes = page.locator("openclaw-chat-pane.chat-split-view__pane");
        await expect.poll(() => panes.count()).toBe(2);
        const firstInput = panes.first().locator(".agent-chat__composer-shell textarea");
        const secondInput = panes.last().locator(".agent-chat__composer-shell textarea");
        await firstInput.fill("/btw what is this?");
        await firstInput.press("Enter");
        await gateway.waitForRequest("sessions.companion.ask");
        const sideInput = panes
          .first()
          .getByRole("textbox", { name: "Ask in side chat", exact: true });
        await expect.poll(() => sideInput.isDisabled()).toBe(true);
        await secondInput.fill("Keep typing here");
        const foregroundInput = returnToFirstPane ? firstInput : secondInput;
        if (returnToFirstPane) {
          await firstInput.fill("Keep typing here");
        }
        await gateway.resolveDeferred("sessions.companion.ask", {
          answer: "A side conversation.",
          ts: 1,
        });
        await panes.first().getByText("A side conversation.", { exact: true }).waitFor();
        await expect.poll(() => sideInput.isDisabled()).toBe(false);
        expect(
          await foregroundInput.evaluate((element) => document.activeElement === element),
        ).toBe(true);
        await page.keyboard.type(".");
        expect(await foregroundInput.inputValue()).toBe("Keep typing here.");
        expect(await sideInput.inputValue()).toBe("");
      });
    },
  );

  it("preserves main focus when the global session changes agent during a side question", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        sessionKey: "global",
        sessionScope: "global",
        deferredMethods: ["sessions.companion.ask"],
        methodResponses: {
          "agent.identity.get": {
            cases: ["main", "work"].map((agentId) => ({
              match: { agentId },
              response: { agentId, name: agentId, avatar: "", avatarStatus: "none" },
            })),
          },
          "agents.list": {
            agents: [
              { id: "main", name: "Main" },
              { id: "work", name: "Work" },
            ],
            defaultId: "main",
            mainKey: "main",
            scope: "global",
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      const mainInput = page.locator(".agent-chat__composer-shell textarea");
      const sideInput = page.locator(".chat-session-rail__input");
      await mainInput.fill("/btw what is this?");
      await mainInput.press("Enter");
      const request = await gateway.waitForRequest("sessions.companion.ask");
      expect(request.params).toMatchObject({ agentId: "main", sessionKey: "global" });
      await expect.poll(() => sideInput.isDisabled()).toBe(true);
      // The shared selection owner also publishes background roster reconciliation.
      await page.evaluate(() => {
        const app = document.querySelector("openclaw-app") as HTMLElement & {
          runtime: { context: { agentSelection: { set: (agent: string) => void } } };
        };
        app.runtime.context.agentSelection.set("work");
      });
      await expect.poll(() => sideInput.isDisabled()).toBe(false);
      expect(await mainInput.evaluate((element) => document.activeElement === element)).toBe(true);
      await gateway.resolveDeferred("sessions.companion.ask", {
        answer: "Old agent answer",
        ts: 1,
      });
      await page.locator("openclaw-chat-pane").evaluate(async (pane) => {
        await (pane as HTMLElement & { updateComplete: Promise<unknown> }).updateComplete;
        const rail = pane.querySelector("openclaw-chat-session-rail") as HTMLElement & {
          updateComplete: Promise<unknown>;
        };
        await rail.updateComplete;
      });
      expect(await mainInput.evaluate((element) => document.activeElement === element)).toBe(true);
      await page.keyboard.type("New agent draft");
      expect(await mainInput.inputValue()).toBe("New agent draft");
      expect(await sideInput.inputValue()).toBe("");
      expect(await page.getByText("Old agent answer", { exact: true }).count()).toBe(0);
    });
  });

  it.each([
    "draft",
    "cleared draft",
    "history",
    "click",
    "command palette",
    "sidebar menu",
    "sidebar menu before mount",
  ])("preserves newer input intent while a side answer is pending: %s", async (intent) => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const held =
        intent === "sidebar menu before mount"
          ? await holdModuleResponse(page, /\/assets\/chat-session-rail-[^/]+\.js$/u)
          : null;
      try {
        const gateway = await installMockGateway(page, {
          deferredMethods: ["sessions.companion.ask"],
          sessions: [
            { key: "agent:main:sidebar-focus", label: "Sidebar focus", updatedAt: Date.now() },
          ],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const mainInput = page.locator(".agent-chat__composer-shell textarea");
        await mainInput.fill("/btw what is this?");
        await mainInput.press("Enter");
        await gateway.waitForRequest("sessions.companion.ask");
        const sideInput = page.locator(".chat-session-rail__input");
        if (held) {
          await held.request;
          expect(await sideInput.count()).toBe(0);
        } else {
          await expect.poll(() => sideInput.isDisabled()).toBe(true);
        }
        expect(await mainInput.evaluate((element) => document.activeElement === element)).toBe(
          true,
        );
        let foregroundInput = mainInput;
        if (intent === "click") {
          await mainInput.click();
        } else if (intent === "history") {
          await page.keyboard.press("ArrowUp");
          expect(await mainInput.inputValue()).toBe("/btw what is this?");
          await page.keyboard.press("ArrowDown");
          expect(await mainInput.inputValue()).toBe("");
        } else if (intent === "command palette") {
          await page.keyboard.press("ControlOrMeta+k");
          foregroundInput = page
            .locator("openclaw-command-palette")
            .getByRole("textbox", { name: "Search or start a task…" });
          await foregroundInput.fill("Keep typing here");
        } else if (intent === "sidebar menu" || intent === "sidebar menu before mount") {
          await page
            .getByRole("button", { name: "Open session menu: Sidebar focus", exact: true })
            .focus();
          await page.keyboard.press("Enter");
          await openSessionMenuSubmenu(page, "Icon & color");
          await page.getByRole("button", { name: "Custom icon…", exact: true }).click();
          foregroundInput = page.getByRole("textbox", { name: "Custom icon", exact: true });
          await foregroundInput.fill("Keep typing here");
        } else {
          await page.keyboard.type("Keep typing here");
          if (intent === "cleared draft") {
            await page.keyboard.press("ControlOrMeta+A");
            await page.keyboard.press("Backspace");
          }
        }
        await gateway.resolveDeferred("sessions.companion.ask", {
          answer: "A side conversation.",
          ts: 1,
        });
        held?.release();
        await page.getByText("A side conversation.", { exact: true }).waitFor();
        await expect.poll(() => sideInput.isDisabled()).toBe(false);
        expect(
          await foregroundInput.evaluate((element) => document.activeElement === element),
        ).toBe(true);
        await page.keyboard.type(".");
        expect(await foregroundInput.inputValue()).toBe(
          intent === "cleared draft" || intent === "click" || intent === "history"
            ? "."
            : "Keep typing here.",
        );
        expect(await sideInput.inputValue()).toBe("");
      } finally {
        held?.release();
      }
    });
  });

  it("does not steal focus back when the side-chat history finishes loading", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        deferredMethods: ["sessions.companion.state"],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("sessions.companion.state");
      await openChatSidePanelType(page, "Side chat");
      const input = page.getByRole("textbox", { name: "Ask in side chat", exact: true });
      await expect
        .poll(() => input.evaluate((element) => document.activeElement === element))
        .toBe(true);
      const mainInput = page.locator(".agent-chat__composer-shell textarea");
      await mainInput.fill("Keep typing here");
      await gateway.resolveDeferred("sessions.companion.state", {
        exchanges: [{ question: "What changed?", answer: "The introduction is ready.", ts: 1 }],
      });
      await page.getByText("The introduction is ready.", { exact: true }).waitFor();
      expect(await mainInput.evaluate((element) => document.activeElement === element)).toBe(true);
      await page.keyboard.type(".");
      expect(await mainInput.inputValue()).toBe("Keep typing here.");
    });
  });
});
