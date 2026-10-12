import { writeFile } from "node:fs/promises";
import path from "node:path";
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

suite.define(() => {
  it.each(["side chat", "main composer", "another pane", "command palette"])(
    "honors focus intent in %s while a manually opened Side chat loads",
    async (target) => {
      const viewport =
        target === "another pane" || target === "command palette"
          ? { width: 2200, height: 1000 }
          : { width: 1440, height: 900 };
      await suite.withPage({ viewport }, async ({ page }) => {
        const artifacts = createControlUiE2eArtifactDir(
          `companion-manual-${target.replaceAll(" ", "-")}`,
        );
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        const held = await holdModuleResponse(
          page,
          controlUiE2eBuiltModuleRequest("ui/src/pages/chat/components/chat-session-rail.ts"),
        );
        try {
          const gateway = await installMockGateway(page);
          await page.goto(`${suite.server.baseUrl}chat`);
          await openChatSidePanelType(page, "Side chat");
          await held.request;
          let side = page.getByRole("textbox", { name: "Ask in side chat", exact: true });
          expect(await side.count()).toBe(0);
          const main = page.locator(".agent-chat__composer-shell textarea").first();
          let foreground = main;
          if (target === "another pane") {
            await selectChatLayoutAction(page, "Open split view");
            const panes = page.locator("openclaw-chat-pane.chat-split-view__pane");
            await expect.poll(() => panes.count()).toBe(2);
            foreground = panes.last().locator(".agent-chat__composer-shell textarea");
            side = panes.first().getByRole("textbox", { name: "Ask in side chat", exact: true });
          } else if (target === "command palette") {
            await page.keyboard.press("ControlOrMeta+k");
            foreground = page
              .locator("openclaw-command-palette")
              .getByRole("textbox", { name: "Search or start a task…" });
          }
          if (target !== "side chat") {
            await foreground.click();
            await page.keyboard.type("Keep typing here");
            expect(await foreground.inputValue()).toBe("Keep typing here");
            expect(await foreground.evaluate((element) => document.activeElement === element)).toBe(
              true,
            );
          }
          await page.screenshot({ path: path.join(artifacts, "before-rail-arrives.png") });
          held.release();
          await side.waitFor();
          if (target === "side chat") {
            foreground = side;
          }
          expect
            .soft(await main.evaluate((element) => document.activeElement === element))
            .toBe(target === "main composer");
          expect
            .soft(await side.evaluate((element) => document.activeElement === element))
            .toBe(target === "side chat");
          const foregroundFocused = await foreground.evaluate(
            (element) => document.activeElement === element,
          );
          await page.keyboard.type(" continued");
          const foregroundDraft = await foreground.inputValue();
          const mainDrafts = await Promise.all(
            (await page.locator(".agent-chat__composer-shell textarea").all()).map((input) =>
              input.inputValue(),
            ),
          );
          const sideDrafts = await Promise.all(
            (await page.getByRole("textbox", { name: "Ask in side chat", exact: true }).all()).map(
              (input) => input.inputValue(),
            ),
          );
          await page.screenshot({ path: path.join(artifacts, "after-rail-and-continuation.png") });
          const requests = (await gateway.getRequests()).map(({ method }) => method);
          await writeFile(
            path.join(artifacts, "receipt.json"),
            JSON.stringify(
              {
                target,
                foregroundFocused,
                foregroundDraft,
                mainDrafts,
                sideDrafts,
                requests,
                pageErrors,
              },
              null,
              2,
            ),
          );
          expect.soft(foregroundFocused).toBe(true);
          expect
            .soft(foregroundDraft)
            .toBe(target === "side chat" ? " continued" : "Keep typing here continued");
          expect
            .soft(mainDrafts)
            .toEqual(
              target === "another pane"
                ? ["", "Keep typing here continued"]
                : [target === "main composer" ? "Keep typing here continued" : ""],
            );
          expect
            .soft(sideDrafts)
            .toEqual(
              target === "another pane" ? ["", ""] : [target === "side chat" ? " continued" : ""],
            );
          expect.soft(pageErrors).toEqual([]);
          expect.soft(requests.filter((method) => method === "sessions.companion.ask")).toEqual([]);
          expect.soft(requests.filter((method) => method === "chat.send")).toEqual([]);
        } finally {
          held.release();
        }
      });
    },
  );
  it.each(["new focus", "continued typing"])(
    "preserves queued-editor %s while Side chat loads",
    async (intent) => {
      await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
        const artifacts = createControlUiE2eArtifactDir(
          `companion-manual-queue-${intent.replaceAll(" ", "-")}`,
        );
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        const held = await holdModuleResponse(
          page,
          controlUiE2eBuiltModuleRequest("ui/src/pages/chat/components/chat-session-rail.ts"),
        );
        try {
          const gateway = await installMockGateway(page);
          await page.goto(`${suite.server.baseUrl}settings/appearance`);
          await page.locator("[data-settings-follow-up-mode]").selectOption("queue");
          await page.goto(`${suite.server.baseUrl}chat?session=main`);
          const main = page.getByRole("textbox", { name: "Chat composer", exact: true });
          await main.fill("Keep the first run active");
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
            messages: [
              {
                role: "user",
                content: "Keep the first run active",
                idempotencyKey: `${runId}:user`,
              },
            ],
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
          expect(await editor.evaluate((element) => document.activeElement === element)).toBe(true);
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
          expect(await editor.evaluate((element) => document.activeElement === element)).toBe(true);
          await page.keyboard.type(" changed");
          expect(await editor.inputValue()).toBe("Queued correction changed");
          await page.screenshot({ path: path.join(artifacts, "before-rail-arrives.png") });
          held.release();
          const side = page.getByRole("textbox", { name: "Ask in side chat", exact: true });
          await side.waitFor();
          expect(await side.isEnabled()).toBe(true);
          const editorFocused = await editor.evaluate(
            (element) => document.activeElement === element,
          );
          await page.keyboard.type(" continued");
          const drafts = {
            main: await main.inputValue(),
            queued: await editor.inputValue(),
            side: await side.inputValue(),
          };
          const requests = (await gateway.getRequests()).map(({ method }) => method);
          await page.screenshot({ path: path.join(artifacts, "after-rail-and-continuation.png") });
          await writeFile(
            path.join(artifacts, "receipt.json"),
            JSON.stringify({ intent, editorFocused, drafts, requests, pageErrors }, null, 2),
          );
          expect.soft(editorFocused).toBe(true);
          expect.soft(drafts).toEqual({
            main: "Separate main draft",
            queued: "Queued correction changed continued",
            side: "",
          });
          expect.soft(await editor.count()).toBe(1);
          expect.soft(requests.filter((method) => method === "chat.send")).toHaveLength(1);
          expect.soft(requests.filter((method) => method === "sessions.companion.ask")).toEqual([]);
          expect.soft(pageErrors).toEqual([]);
        } finally {
          held.release();
        }
      });
    },
  );
});
