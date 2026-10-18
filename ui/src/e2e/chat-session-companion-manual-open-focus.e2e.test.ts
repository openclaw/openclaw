import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { requireRecord, requireString } from "./chat-flow.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";
import {
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Manual Side chat opening focus" });
const isFocused = (input: Locator) =>
  input.evaluate((element) => document.activeElement === element);
const textbox = (scope: Page | Locator, name = "Ask in side chat") =>
  scope.getByRole("textbox", { name, exact: true });
async function holdSideChat(page: Page, name: string) {
  const artifacts = createControlUiE2eArtifactDir(`companion-manual-${name.replaceAll(" ", "-")}`);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const held = await holdModuleResponse(
    page,
    controlUiE2eBuiltModuleRequest("ui/src/pages/chat/components/chat-session-rail.tsx"),
  );
  const capture = (file: string) => page.screenshot({ path: path.join(artifacts, file + ".png") });
  return { held, pageErrors, capture, gateway: await installMockGateway(page) };
}
async function drafts(inputs: Locator) {
  return Promise.all((await inputs.all()).map((input) => input.inputValue()));
}

suite.define(() => {
  it.each(["side chat", "main composer", "another pane", "command palette"])(
    "honors focus intent in %s while a manually opened Side chat loads",
    async (target) => {
      const viewport =
        target === "another pane" || target === "command palette"
          ? { width: 2200, height: 1000 }
          : { width: 1440, height: 900 };
      await suite.withPage({ viewport }, async ({ page }) => {
        const { gateway, held, pageErrors, capture } = await holdSideChat(page, target);
        await page.goto(`${suite.server.baseUrl}chat`);
        await openChatSidePanelType(page, "Side chat");
        await held.request;
        let side = textbox(page);
        expect(await side.count()).toBe(0);
        const main = page.locator(".agent-chat__composer-shell textarea").first();
        let foreground = main;
        if (target === "another pane") {
          await selectChatLayoutAction(page, "Open split view");
          const panes = page.locator("openclaw-chat-pane.chat-split-view__pane");
          await expect.poll(() => panes.count()).toBe(2);
          foreground = panes.last().locator(".agent-chat__composer-shell textarea");
          side = textbox(panes.first());
        } else if (target === "command palette") {
          await page.keyboard.press("ControlOrMeta+k");
          foreground = textbox(page.locator("openclaw-command-palette"), "Search or start a task…");
        }
        if (target !== "side chat") {
          await foreground.click();
          await page.keyboard.type("Keep typing here");
          expect(await foreground.inputValue()).toBe("Keep typing here");
          expect(await isFocused(foreground)).toBe(true);
        }
        await capture("before-rail-arrives");
        held.release();
        await side.waitFor();
        if (target === "side chat") {
          foreground = side;
        }
        expect.soft(await isFocused(main)).toBe(target === "main composer");
        expect.soft(await isFocused(side)).toBe(target === "side chat");
        const foregroundFocused = await isFocused(foreground);
        await page.keyboard.type(" continued");
        const actual = {
          focused: foregroundFocused,
          draft: await foreground.inputValue(),
          mainDrafts: await drafts(page.locator(".agent-chat__composer-shell textarea")),
          sideDrafts: await drafts(textbox(page)),
        };
        await capture("after-rail-and-continuation");
        const requests = (await gateway.getRequests()).map(({ method }) => method);
        const continued = "Keep typing here continued";
        expect.soft(actual).toEqual({
          focused: true,
          draft: target === "side chat" ? " continued" : continued,
          mainDrafts:
            target === "another pane"
              ? ["", continued]
              : [target === "main composer" ? continued : ""],
          sideDrafts:
            target === "another pane" ? ["", ""] : [target === "side chat" ? " continued" : ""],
        });
        expect.soft(pageErrors).toEqual([]);
        const sends = requests.filter((method) =>
          /^(sessions\.companion\.ask|chat\.send)$/u.test(method),
        );
        expect.soft(sends).toEqual([]);
      });
    },
  );
  it.each(["new focus", "continued typing"])(
    "preserves queued-editor %s while Side chat loads",
    async (intent) => {
      await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
        const { gateway, held, pageErrors, capture } = await holdSideChat(page, `queue-${intent}`);
        await page.goto(`${suite.server.baseUrl}settings/appearance`);
        await page.locator("[data-settings-follow-up-mode]").selectOption("queue");
        await page.goto(`${suite.server.baseUrl}chat?session=main`);
        const main = textbox(page, "Chat composer");
        const content = "Keep the first run active";
        await main.fill(content);
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        const active = requireRecord((await gateway.waitForRequest("chat.send")).params);
        const runId = requireString(active.idempotencyKey, "active run idempotency key");
        await page.getByRole("button", { name: "Stop generating", exact: true }).waitFor();
        const acceptedSession = {
          key: "agent:main:main",
          sessionId: "session:agent:main:main",
          hasActiveRun: true,
          activeRunIds: [runId],
          status: "running",
        };
        await gateway.setMethodResponse("chat.history", {
          sessionId: acceptedSession.sessionId,
          sessionInfo: acceptedSession,
          messages: [{ role: "user", content, idempotencyKey: `${runId}:user` }],
        });
        await gateway.emitGatewayEvent("sessions.changed", acceptedSession);
        await page.locator(".chat-send-status").waitFor({ state: "detached" });
        await main.fill("Queued correction");
        await page.getByRole("button", { name: "Queue message", exact: true }).click();
        const row = page.locator(".chat-queue__item", { hasText: "Queued correction" });
        await row.waitFor();
        await main.fill("Separate main draft");
        await row.dblclick();
        const editor = page.locator(".chat-queue__edit-input");
        await editor.waitFor();
        expect(await isFocused(editor)).toBe(true);
        if (intent === "continued typing") {
          await page.keyboard.press("ControlOrMeta+Shift+s");
        } else {
          await openChatSidePanelType(page, "Side chat");
        }
        await held.request;
        if (intent === "new focus") {
          await editor.click();
          await page.keyboard.press("End");
        }
        expect(await isFocused(editor)).toBe(true);
        await page.keyboard.type(" changed");
        expect(await editor.inputValue()).toBe("Queued correction changed");
        await capture("before-rail-arrives");
        held.release();
        const side = textbox(page);
        await side.waitFor();
        expect(await side.isEnabled()).toBe(true);
        const editorFocused = await isFocused(editor);
        await page.keyboard.type(" continued");
        const values = await Promise.all([main, editor, side].map((input) => input.inputValue()));
        const requests = (await gateway.getRequests()).map(({ method }) => method);
        await capture("after-rail-and-continuation");
        expect.soft(editorFocused).toBe(true);
        expect
          .soft(values)
          .toEqual(["Separate main draft", "Queued correction changed continued", ""]);
        expect.soft(await editor.count()).toBe(1);
        expect.soft(requests.filter((method) => method === "chat.send")).toHaveLength(1);
        expect.soft(requests.filter((method) => method === "sessions.companion.ask")).toEqual([]);
        expect.soft(pageErrors).toEqual([]);
      });
    },
  );
});
