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

const suite = createControlUiE2eSuite({ name: "side-chat input focus" });
const mainComposer = (scope: Page | Locator) =>
  scope.locator(".agent-chat__composer-shell textarea");
const sideComposer = (scope: Page | Locator) =>
  scope.getByRole("textbox", { name: "Ask in side chat", exact: true });
const focused = (input: Locator) => input.evaluate((element) => document.activeElement === element);
const expectFocus = (input: Locator) => expect.poll(() => focused(input)).toBe(true);
type FocusPage = {
  page: Page;
  gateway: MockGatewayControls;
  main: Locator;
  side: Locator;
  railRequest?: Promise<unknown>;
  releaseRail: () => void;
};
async function withChat(
  options: {
    viewport?: { width: number; height: number };
    scenario?: ControlUiMockGatewayScenario;
    holdRail?: boolean;
  },
  run: (fixture: FocusPage) => Promise<void>,
) {
  await suite.withPage(
    { viewport: options.viewport ?? { width: 1440, height: 900 } },
    async ({ page }) => {
      const held = options.holdRail
        ? await holdModuleResponse(
            page,
            controlUiE2eBuiltModuleRequest("ui/src/pages/chat/components/chat-session-rail.tsx"),
          )
        : null;
      try {
        const gateway = await installMockGateway(page, options.scenario);
        await page.goto(`${suite.server.baseUrl}chat`);
        await run({
          page,
          gateway,
          main: mainComposer(page),
          side: sideComposer(page),
          railRequest: held?.request,
          releaseRail: () => held?.release(),
        });
      } finally {
        held?.release();
      }
    },
  );
}
async function enterSideCommand(scope: Page | Locator, command = "/btw what is this?") {
  const input = mainComposer(scope);
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
async function typeWhileFocused(page: Page, input: Locator, text: string, expected: string) {
  expect(await focused(input)).toBe(true);
  await page.keyboard.type(text);
  expect(await input.inputValue()).toBe(expected);
}

suite.define(() => {
  it.each([
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ])("focuses Side chat on open, reopen, and tab activation at $width px", async (viewport) => {
    await withChat({ viewport }, async ({ page, side }) => {
      await openChatSidePanelType(page, "Side chat");
      await expectFocus(side);
      await page.keyboard.type("Ready to ask");
      expect(await side.inputValue()).toBe("Ready to ask");
      await selectChatLayoutAction(page, "Minimize side panel");
      await selectChatLayoutAction(page, /^(Side panel|Minimize side panel)$/);
      await expectFocus(side);
      expect(await side.inputValue()).toBe("Ready to ask");
      await openChatSidePanelType(page, "Files");
      await page.getByRole("tab", { name: "Side chat", exact: true }).click();
      await expectFocus(side);
      await page.keyboard.type(" again");
      expect(await side.inputValue()).toBe("Ready to ask again");
    });
  });
  it.each([
    { command: "/btw", action: "newer main focus" },
    { command: "/side", action: "newer main focus" },
    { command: "/btw", action: "close" },
    { command: "/btw", action: "minimize" },
    { command: "/btw", action: "switch tabs" },
  ])("hands off delayed $command focus after $action", async ({ command, action }) => {
    await withChat({ holdRail: true }, async ({ page, main, side, railRequest, releaseRail }) => {
      await enterSideCommand(page, command);
      await railRequest;
      expect(await side.count()).toBe(0);
      if (action === "newer main focus") {
        expect(await main.inputValue()).toBe("");
        await main.click();
        releaseRail();
        await side.waitFor();
        await typeWhileFocused(page, main, "Keep typing here", "Keep typing here");
        expect(await side.inputValue()).toBe("");
        await page.getByRole("button", { name: "Close Side chat", exact: true }).click();
        await openChatSidePanelType(page, "Side chat");
      } else {
        const tab = page.getByRole("tab", { name: "Side chat", exact: true });
        await tab.waitFor();
        if (action === "close") {
          await page.getByRole("button", { name: "Close Side chat", exact: true }).click();
        } else if (action === "minimize") {
          await selectChatLayoutAction(page, "Minimize side panel");
        } else {
          await openChatSidePanelType(page, "Files");
        }
        releaseRail();
        if (action === "close") {
          await openChatSidePanelType(page, "Side chat");
        } else if (action === "minimize") {
          await selectChatLayoutAction(page, /^(Side panel|Minimize side panel)$/);
        } else {
          await tab.click();
        }
      }
      await expectFocus(side);
      if (action !== "newer main focus") {
        await page.keyboard.type("New opening");
        expect(await side.inputValue()).toBe("New opening");
      }
    });
  });

  it("opens Side chat when selecting /btw from the slash menu", async () => {
    await withChat({}, async ({ page, main, side }) => {
      await main.fill("/bt");
      await page.locator(".chat-send-btn--send:enabled").waitFor({ state: "visible" });
      await page.getByRole("option").filter({ hasText: "/btw" }).click();
      await expectFocus(side);
      expect(await main.inputValue()).toBe("");
    });
  });
  it.each([false, true])(
    "submits a side question and focuses its composer with panel open=%s",
    async (open) => {
      await withChat({ scenario: pendingAsk }, async ({ page, gateway, main, side }) => {
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
        await page.keyboard.type("Follow up");
        expect(await side.inputValue()).toBe("Follow up");
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      });
    },
  );
  it("preserves main focus when the global session changes agent during a side question", async () => {
    await withChat(
      {
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
              agents: [
                { id: "main", name: "Main" },
                { id: "work", name: "Work" },
              ],
              defaultId: "main",
              mainKey: "main",
              scope: "global",
            },
          },
        },
      },
      async ({ page, gateway, main }) => {
        const side = page.locator(".chat-session-rail__input");
        await enterSideCommand(page);
        expect((await gateway.waitForRequest("sessions.companion.ask")).params).toMatchObject({
          agentId: "main",
          sessionKey: "global",
        });
        await waitForPending(page, side);
        await main.focus();
        await evaluateControlUiContext(page, (context) => {
          context.agentSelection.set("work");
        });
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
        await typeWhileFocused(page, main, "New agent draft", "New agent draft");
        expect(await side.inputValue()).toBe("");
        expect(await page.getByText("Old agent answer", { exact: true }).count()).toBe(0);
      },
    );
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
    const scenario = split
      ? pendingAsk
      : {
          ...pendingAsk,
          sessions: [
            { key: "agent:main:sidebar-focus", label: "Sidebar focus", updatedAt: Date.now() },
          ],
        };
    await withChat(
      {
        holdRail,
        scenario,
        viewport: split ? { width: 2200, height: 1000 } : undefined,
      },
      async ({ page, gateway, railRequest, releaseRail }) => {
        const panes = page.locator("openclaw-chat-pane.chat-split-view__pane");
        if (split) {
          await selectChatLayoutAction(page, "Open split view");
          await expect.poll(() => panes.count()).toBe(2);
        }
        const scope = split ? panes.first() : page;
        const main = mainComposer(scope);
        const side = split ? sideComposer(scope) : page.locator(".chat-session-rail__input");
        await enterSideCommand(scope);
        await gateway.waitForRequest("sessions.companion.ask");
        if (holdRail) {
          await railRequest;
          expect(await side.count()).toBe(0);
        } else {
          await waitForPending(page, side);
        }
        let foreground = main;
        if (split) {
          const second = mainComposer(panes.last());
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
              .locator(
                '[data-session-key="agent:main:sidebar-focus"] .sidebar-recent-session__link',
              )
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
        releaseRail();
        await scope.getByText("A side conversation.", { exact: true }).waitFor();
        await expect.poll(() => side.isDisabled()).toBe(false);
        const empty = ["cleared draft", "click", "history"].includes(intent);
        await typeWhileFocused(page, foreground, ".", empty ? "." : "Keep typing here.");
        expect(await side.inputValue()).toBe("");
      },
    );
  });

  it.each(["main", "side"])(
    "preserves the %s draft and focus when side-chat history loads",
    async (target) => {
      await withChat(
        { scenario: { deferredMethods: ["sessions.companion.state"] } },
        async ({ page, gateway, main, side }) => {
          await gateway.waitForRequest("sessions.companion.state");
          await openChatSidePanelType(page, "Side chat");
          await expectFocus(side);
          const draft = target === "main" ? main : side;
          await draft.fill("Keep typing here");
          await gateway.resolveDeferred("sessions.companion.state", {
            exchanges: [{ question: "What changed?", answer: "The introduction is ready.", ts: 1 }],
          });
          await page.getByText("The introduction is ready.", { exact: true }).waitFor();
          await typeWhileFocused(page, draft, ".", "Keep typing here.");
          if (target === "side" && process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim()) {
            await page.screenshot({
              path: path.join(
                createControlUiE2eArtifactDir("side-chat-history"),
                "history-after.png",
              ),
              animations: "disabled",
            });
          }
        },
      );
    },
  );
});
