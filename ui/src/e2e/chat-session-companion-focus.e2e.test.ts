import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import {
  installMockGateway,
  type ControlUiMockGatewayScenario,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";
import {
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";
import { openSessionMenuSubmenu } from "./session-management.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "side-chat input focus",
  trackBrowserContexts: true,
});
const mainInput = (scope: Page | Locator) => scope.locator(".agent-chat__composer-shell textarea");
const sideInput = (scope: Page | Locator) =>
  scope.getByRole("textbox", { name: "Ask in side chat", exact: true });
const focused = (input: Locator) => input.evaluate((element) => document.activeElement === element);
const expectFocus = (input: Locator) => expect.poll(() => focused(input)).toBe(true);
async function openChat(
  options: {
    viewport?: { width: number; height: number };
    scenario?: ControlUiMockGatewayScenario;
    holdRail?: boolean;
  } = {},
) {
  const context = await suite.newBrowserContext({
    viewport: options.viewport ?? { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  const held = options.holdRail
    ? await holdModuleResponse(
        page,
        controlUiE2eBuiltModuleRequest("ui/src/pages/chat/components/chat-session-rail.tsx"),
      )
    : null;
  const gateway = await installMockGateway(page, options.scenario);
  await page.goto(`${suite.server.baseUrl}chat`);
  const main = mainInput(page);
  const side = sideInput(page);
  return { page, gateway, main, side, held };
}
async function enterSideCommand(scope: Page | Locator, command = "/btw what is this?") {
  const input = mainInput(scope);
  await input.fill(command);
  // Drafting precedes history admission; commands still wait for Send readiness.
  await scope.locator(".chat-send-btn--send:enabled").waitFor({ state: "visible" });
  await input.press("Enter");
}
const pendingAsk = { deferredMethods: ["sessions.companion.ask"] };
async function waitForPending(scope: Page | Locator, side: Locator) {
  await scope.locator(".chat-session-rail__exchange--pending").waitFor();
  expect(await side.isDisabled()).toBe(false);
}
async function resolveAnswer(gateway: MockGatewayControls, answer = "A side conversation.") {
  await gateway.resolveDeferred("sessions.companion.ask", { answer, ts: 1 });
}
async function typeFocused(page: Page, input: Locator, text: string, expected = text) {
  expect(await focused(input)).toBe(true);
  await page.keyboard.type(text);
  expect(await input.inputValue()).toBe(expected);
}

suite.define(() => {
  it.each([
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ])("focuses Side chat on open, reopen, and tab activation at $width px", async (viewport) => {
    const { page, side } = await openChat({ viewport });
    await openChatSidePanelType(page, "Side chat");
    await expectFocus(side);
    await typeFocused(page, side, "Ready to ask");
    await selectChatLayoutAction(page, "Minimize side panel");
    await selectChatLayoutAction(page, /^(Side panel|Minimize side panel)$/);
    await expectFocus(side);
    expect(await side.inputValue()).toBe("Ready to ask");
    await openChatSidePanelType(page, "Files");
    await page.getByRole("tab", { name: "Side chat", exact: true }).click();
    await expectFocus(side);
    await typeFocused(page, side, " again", "Ready to ask again");
  });
  it.each([
    { command: "/btw", action: "close" },
    { command: "/btw", action: "minimize" },
    { command: "/btw", action: "switch tabs" },
  ])("hands off delayed $command focus after $action", async ({ command, action }) => {
    const { page, side, held } = await openChat({ holdRail: true });
    await enterSideCommand(page, command);
    await held?.request;
    expect(await side.count()).toBe(0);
    const tab = page.getByRole("tab", { name: "Side chat", exact: true });
    await tab.waitFor();
    if (action === "close") {
      const close = page.getByRole("button", { name: "Close Side chat", exact: true });
      await close.click();
      await close.waitFor({ state: "hidden" });
    } else if (action === "minimize") {
      await selectChatLayoutAction(page, "Minimize side panel");
    } else {
      await openChatSidePanelType(page, "Files");
    }
    held?.release();
    if (action === "close") {
      await openChatSidePanelType(page, "Side chat");
    } else if (action === "minimize") {
      await selectChatLayoutAction(page, /^(Side panel|Minimize side panel)$/);
    } else {
      await tab.click();
    }
    await expectFocus(side);
    await typeFocused(page, side, "New opening");
  });

  it("opens Side chat when the slash catalog refreshes during selection", async () => {
    const { page, gateway, main, side } = await openChat({
      scenario: { deferredMethods: ["commands.list"] },
    });
    await main.fill("/bt");
    await page.locator(".chat-send-btn--send:enabled").waitFor({ state: "visible" });
    await gateway.waitForRequest("commands.list");
    const option = page.getByRole("option").filter({ hasText: "/btw" });
    await option.hover();
    await page.mouse.down();
    await gateway.resolveDeferred("commands.list", {
      commands: [
        {
          name: "btcheck",
          textAliases: ["/btcheck"],
          description: "Catalog refresh arrived.",
          source: "plugin",
          scope: "text",
          acceptsArgs: false,
        },
      ],
    });
    await page.getByRole("option").filter({ hasText: "/btcheck" }).waitFor();
    // Keep the release on the pressed option after the menu grows upward.
    await option.hover();
    await page.mouse.up();
    await expectFocus(side);
    expect(await main.inputValue()).toBe("");
  });
  it.each([false, true])("focuses side questions with panel open=%s", async (open) => {
    const { page, gateway, main, side } = await openChat({ scenario: pendingAsk });
    if (open) {
      await openChatSidePanelType(page, "Side chat");
      await expectFocus(side);
    }
    await enterSideCommand(page);
    expect((await gateway.waitForRequest("sessions.companion.ask")).params).toMatchObject({
      question: "what is this?",
    });
    await waitForPending(page, side);
    await resolveAnswer(gateway);
    await page.getByText("A side conversation.", { exact: true }).waitFor();
    await expectFocus(side);
    expect(await main.inputValue()).toBe("");
    await typeFocused(page, side, "Follow up");
    expect(await gateway.getRequests("chat.send")).toHaveLength(0);
  });
  it("preserves main focus when the global session changes agent during a side question", async () => {
    const { page, gateway, main } = await openChat({
      scenario: {
        ...pendingAsk,
        sessionKey: "global",
        sessionScope: "global",
        methodResponses: {
          "agent.identity.get": {
            cases: ["main", "work"].map((agentId) => ({
              match: { agentId },
              response: { agentId, name: agentId, avatar: "", avatarStatus: "none" },
            })),
          },
          "agents.list": {
            agents: ["Main", "Work"].map((name) => ({ id: name.toLowerCase(), name })),
            defaultId: "main",
            mainKey: "main",
            scope: "global",
          },
        },
      },
    });
    const side = page.locator(".chat-session-rail__input");
    await enterSideCommand(page);
    expect((await gateway.waitForRequest("sessions.companion.ask")).params).toMatchObject({
      agentId: "main",
      sessionKey: "global",
    });
    await waitForPending(page, side);
    await main.focus();
    await evaluateControlUiContext(page, (context) => context.agentSelection.set("work"));
    await expect.poll(() => side.isDisabled()).toBe(false);
    expect(await focused(main)).toBe(true);
    await resolveAnswer(gateway, "Old agent answer");
    await page.locator("openclaw-chat-pane").evaluate(async (pane) => {
      await (pane as HTMLElement & { updateComplete: Promise<unknown> }).updateComplete;
      const rail = pane.querySelector("openclaw-chat-session-rail") as HTMLElement & {
        updateComplete: Promise<unknown>;
      };
      await rail.updateComplete;
    });
    await typeFocused(page, main, "New agent draft");
    expect(await side.inputValue()).toBe("");
    expect(await page.getByText("Old agent answer", { exact: true }).count()).toBe(0);
  });
  it.each([
    "draft",
    "cleared draft",
    "history",
    "click",
    "command palette",
    "sidebar menu",
    "sidebar menu before mount",
    "other pane",
    "return to first pane",
  ])("preserves newer input intent while a side answer is pending: %s", async (intent) => {
    const holdRail = intent === "sidebar menu before mount";
    const split = intent === "other pane" || intent === "return to first pane";
    const { page, gateway, held } = await openChat({
      holdRail,
      scenario: {
        ...pendingAsk,
        sessions: split
          ? undefined
          : [{ key: "agent:main:sidebar-focus", label: "Sidebar focus", updatedAt: Date.now() }],
      },
      viewport: split ? { width: 2200, height: 1000 } : undefined,
    });
    const panes = page.locator("openclaw-chat-pane.chat-split-view__pane");
    if (split) {
      await selectChatLayoutAction(page, "Open split view");
      await expect.poll(() => panes.count()).toBe(2);
    }
    const scope = split ? panes.first() : page;
    const main = mainInput(scope);
    const side = split ? sideInput(scope) : page.locator(".chat-session-rail__input");
    await enterSideCommand(scope);
    await gateway.waitForRequest("sessions.companion.ask");
    if (holdRail) {
      await held?.request;
      expect(await side.count()).toBe(0);
    } else {
      await waitForPending(page, side);
    }
    let foreground = main;
    if (split) {
      const second = mainInput(panes.last());
      await second.fill("Keep typing here");
      foreground = intent === "other pane" ? second : main;
      if (intent === "return to first pane") {
        await main.fill("Keep typing here");
      }
    } else {
      // Reclaim the main composer after the opening's initial focus handoff.
      await main.focus();
      if (intent === "click") {
        await main.click();
      } else if (intent === "history") {
        await page.keyboard.press("ArrowUp");
        expect(await main.inputValue()).toBe("/btw what is this?");
        await page.keyboard.press("ArrowDown");
        expect(await main.inputValue()).toBe("");
      } else if (intent === "command palette") {
        await page.keyboard.press("ControlOrMeta+k");
        foreground = page
          .locator("openclaw-command-palette")
          .getByRole("textbox", { name: "Search or start a task…" });
        await foreground.fill("Keep typing here");
      } else if (intent === "sidebar menu" || holdRail) {
        await page
          .locator('[data-session-key="agent:main:sidebar-focus"] .sidebar-recent-session__link')
          .focus();
        await page.keyboard.press("Shift+F10");
        await openSessionMenuSubmenu(page, "Advanced");
        await openSessionMenuSubmenu(page, "Icon & color");
        await page.getByRole("button", { name: "Custom icon…", exact: true }).click();
        foreground = page.getByRole("textbox", { name: "Custom icon", exact: true });
        await foreground.fill("Keep typing here");
      } else {
        await page.keyboard.type("Keep typing here");
        if (intent === "cleared draft") {
          await page.keyboard.press("ControlOrMeta+A");
          await page.keyboard.press("Backspace");
        }
      }
    }
    await resolveAnswer(gateway);
    held?.release();
    await scope.getByText("A side conversation.", { exact: true }).waitFor();
    await expect.poll(() => side.isDisabled()).toBe(false);
    const empty = ["cleared draft", "click", "history"].includes(intent);
    await typeFocused(page, foreground, ".", empty ? "." : "Keep typing here.");
    expect(await side.inputValue()).toBe("");
  });

  it.each(["main", "side"])("preserves %s draft/focus on history load", async (target) => {
    const { page, gateway, main, side } = await openChat({
      scenario: { deferredMethods: ["sessions.companion.state"] },
    });
    await gateway.waitForRequest("sessions.companion.state");
    await openChatSidePanelType(page, "Side chat");
    await expectFocus(side);
    const draft = target === "main" ? main : side;
    await draft.fill("Keep typing here");
    await gateway.resolveDeferred("sessions.companion.state", {
      exchanges: [{ question: "What changed?", answer: "The introduction is ready.", ts: 1 }],
    });
    await page.getByText("The introduction is ready.", { exact: true }).waitFor();
    await typeFocused(page, draft, ".", "Keep typing here.");
    if (target === "side" && process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim()) {
      await page.screenshot({
        path: path.join(createControlUiE2eArtifactDir("side-chat-history"), "history-after.png"),
        animations: "disabled",
      });
    }
  });
});
