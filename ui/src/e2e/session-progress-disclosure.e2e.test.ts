import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { controlUiBundledSettingsStorageKey } from "../test-helpers/control-ui-e2e.ts";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

async function installProgressGateway(page: Page, sessionKey: string, canonicalKey = sessionKey) {
  const session = {
    key: canonicalKey,
    sessionId: `session:${sessionKey}`,
    kind: "direct",
    updatedAt: 1,
    hasActiveRun: true,
    activeRunIds: ["progress-run"],
  };
  return installMockGateway(page, {
    sessionKey,
    sessionInfo: session,
    sessions: [session],
    inFlightRun: { runId: "progress-run", startedAt: Date.now() },
    historyMessages: Array.from({ length: 80 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      content: [{ type: "text", text: `History ${index}: ${"Reading context. ".repeat(8)}` }],
    })),
    methodResponses: {
      "progressCard.get": {
        cases: [
          {
            match: { sessionKey: canonicalKey },
            response: {
              card: {
                sessionKey: canonicalKey,
                revision: 1,
                updatedAt: Date.now(),
                steps: [
                  { step: "Inspect the conversation", status: "in_progress" },
                  { step: "Verify navigation", status: "pending" },
                ],
              },
            },
          },
        ],
      },
    },
  });
}

suite.define(() => {
  it("wires settled transcript gestures, escalation, keyboard choices, and visit reset", async () => {
    const artifactDir = createControlUiE2eArtifactDir("session-progress-disclosure");
    const context = await suite.newBrowserContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    const sessionKey = "agent:main:main";
    const gateway = await installProgressGateway(page, sessionKey);
    const card = page.locator(".session-progress-card--composer");
    const thread = page.locator(".chat-thread");
    const open = () => card.evaluate((element) => (element as HTMLDetailsElement).open);
    const gestureOffsets: Array<{ requested: number; before: number; after: number }> = [];
    const gestures = async (count: number, distance: number) => {
      await waitForChatScrollIdle(page);
      const point = await thread.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + 80 };
      });
      await page.mouse.move(point.x, point.y);
      for (let index = 0; index < count; index++) {
        if (index) {
          await page.waitForTimeout(201); // Distinct user gestures, beyond the 200 ms burst boundary.
        }
        const before = await thread.evaluate((element) => element.scrollTop);
        const wheel = await thread.evaluateHandle((element) => {
          const controller = new AbortController();
          return {
            delivered: new Promise<void>((resolve) => {
              element.addEventListener("wheel", () => resolve(), {
                once: true,
                passive: true,
                signal: controller.signal,
              });
            }),
            cancel: () => controller.abort(),
          };
        });
        try {
          await page.mouse.wheel(0, -distance);
          await wheel.evaluate((state) => state.delivered);
        } finally {
          await wheel.evaluate((state) => state.cancel());
          await wheel.dispose();
        }
        await expect
          .poll(() => thread.evaluate((element) => element.scrollTop))
          .toBeLessThan(before);
        gestureOffsets.push({
          requested: distance,
          before,
          after: await thread.evaluate((element) => element.scrollTop),
        });
      }
      await waitForChatScrollIdle(page);
    };
    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await card.waitFor();
      await waitForChatScrollIdle(page);
      expect(await open()).toBe(true);
      await gestures(1, 500);
      await page.waitForTimeout(300);
      expect(await open()).toBe(true);
      await gestures(1, 200);
      await expect.poll(open).toBe(false);
      const retainedCard = await card.elementHandle();
      await gateway.setOnline(false);
      const offline = page.locator('.agent-chat__composer-status[data-tone="info"]');
      await offline.waitFor();
      expect(await retainedCard?.evaluate((element) => element.isConnected)).toBe(true);
      expect(await open()).toBe(false);
      await gateway.setOnline(true);
      await offline.waitFor({ state: "hidden" });
      expect(await retainedCard?.evaluate((element) => element.isConnected)).toBe(true);
      expect(await open()).toBe(false);
      await page.locator('.chat-scroll-to-bottom[data-visible="true"]').click();
      await waitForChatScrollIdle(page);
      expect(await open()).toBe(false);
      await gateway.emitChatFinal({
        sessionKey,
        runId: "progress-run",
        text: "Progress is complete.",
      });
      await page
        .locator(".chat-bubble")
        .getByText("Progress is complete.", { exact: true })
        .waitFor();
      expect(await open()).toBe(false);
      await card.locator("summary").press("Enter");
      expect(await open()).toBe(true);
      await gestures(2, 320);
      await page.waitForTimeout(300);
      expect(await open()).toBe(true);
      await gestures(1, 100);
      await expect.poll(open).toBe(false);
      await card.locator("summary").press("Space");
      expect(await open()).toBe(true);
      await gestures(4, 320);
      await page.waitForTimeout(300);
      expect(await open()).toBe(true);
      const retainedPane = await page.locator("openclaw-chat-pane").elementHandle();
      const sidebar = page.locator("openclaw-app-sidebar");
      await sidebar.locator(".sidebar-identity-card").click();
      await sidebar
        .locator("wa-dropdown.sidebar-identity-menu")
        .getByRole("menuitem", { exact: true, name: "Settings" })
        .click();
      await page.locator("openclaw-chat-pane").waitFor({ state: "hidden" });
      expect(await retainedPane?.evaluate((element) => element.isConnected)).toBe(true);
      await page.goBack();
      await card.waitFor({ state: "visible" });
      await waitForChatScrollIdle(page);
      expect(await open()).toBe(true);
      await gestures(2, 320);
      await expect.poll(open).toBe(false);
      await card.locator("summary").click();
      await card.locator("summary").click();
      await gestures(3, 320);
      await page.waitForTimeout(300);
      expect(await open()).toBe(false);
      await page.reload();
      await card.waitFor();
      await waitForChatScrollIdle(page);
      expect(await open()).toBe(true);
      await card.locator("summary").click();
      expect(await open()).toBe(false);
      await sidebar.locator(".sidebar-identity-card").click();
      await sidebar
        .locator("wa-dropdown.sidebar-identity-menu")
        .getByRole("menuitem", { exact: true, name: "Settings" })
        .click();
      await page.locator('.settings-sidebar__item[href="/settings/connection"]').click();
      const connection = page.locator("openclaw-connection-page .settings-section").filter({
        has: page.locator(".settings-section__heading").getByText("Connection", { exact: true }),
      });
      await connection.getByText("Connected", { exact: true }).waitFor();
      const replacementUrl = "ws://127.0.0.1:19998";
      await connection.getByLabel("Gateway URL", { exact: true }).fill(replacementUrl);
      await connection.getByRole("button", { name: "Apply and reconnect", exact: true }).click();
      await connection.getByText("Connected", { exact: true }).waitFor();
      expect((await gateway.getSocketUrls()).at(-1)).toBe(replacementUrl);
      await page.goBack();
      await page.goBack();
      await card.waitFor();
      expect(await open()).toBe(true);
      await waitForChatScrollIdle(page);
      await gestures(1, 500);
      await gestures(1, 200);
      await expect.poll(open).toBe(false);
    } finally {
      await writeFile(
        path.join(artifactDir, "wheel-offsets.json"),
        JSON.stringify({ gestures: gestureOffsets }, null, 2),
      );
      await page.screenshot({ path: path.join(artifactDir, "last-disclosure-state.png") });
      await suite.closeBrowserContext(context);
    }
  });

  it.each(["automatic", "manual"])(
    "keeps %s collapse in a retained short-name pane through reconnect",
    async (choice) => {
      const artifactDir = createControlUiE2eArtifactDir(`session-progress-reconnect-${choice}`);
      const context = await suite.newBrowserContext({ viewport: { width: 1440, height: 900 } });
      await context.addInitScript((settingsKey) => {
        localStorage.setItem(
          settingsKey,
          JSON.stringify({
            chatSplitLayout: {
              activePaneId: "p1",
              columnWeights: [0.5, 0.5],
              columns: [
                {
                  id: "c1",
                  paneWeights: [1],
                  panes: [{ id: "p1", sessionKey: "agent:main:main" }],
                },
                { id: "c2", paneWeights: [1], panes: [{ id: "p2", sessionKey: "notes" }] },
              ],
            },
          }),
        );
      }, controlUiBundledSettingsStorageKey(suite.server.baseUrl));
      const page = await context.newPage();
      const gateway = await installProgressGateway(page, "notes", "agent:main:notes");
      const card = page.locator(".session-progress-card--composer");
      const pane = page.locator("openclaw-chat-pane").filter({ has: card });
      const thread = pane.locator(".chat-thread");
      const open = () => card.evaluate((element) => (element as HTMLDetailsElement).open);
      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        await card.waitFor();
        await expect
          .poll(() =>
            thread.evaluate(
              (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
            ),
          )
          .toBeLessThan(2);
        expect(
          await pane.evaluate(
            (element) => (element as HTMLElement & { sessionKey: string }).sessionKey,
          ),
        ).toBe("notes");
        if (choice === "automatic") {
          const box = await thread.boundingBox();
          await page.mouse.move(box!.x + box!.width / 2, box!.y + 80);
          for (let index = 0; index < 2; index++) {
            const before = await thread.evaluate((element) => element.scrollTop);
            await page.mouse.wheel(0, -320);
            await expect
              .poll(() => thread.evaluate((element) => element.scrollTop))
              .toBeLessThan(before);
            await page.waitForTimeout(201); // Separate native gestures beyond the 200 ms burst window.
          }
          await expect.poll(open).toBe(false);
        }
        await gateway.setOnline(false);
        await pane.locator('.agent-chat__composer-status[data-tone="info"]').waitFor();
        if (choice === "manual") {
          await card.locator("summary").press("Enter");
          expect(
            await pane.evaluate(
              (element) => (element as HTMLElement & { sessionKey: string }).sessionKey,
            ),
          ).toBe("notes");
        }
        await page.screenshot({ path: path.join(artifactDir, "disconnected.png") });
        expect(await open()).toBe(false);
        await gateway.setOnline(true);
        await pane
          .locator('.agent-chat__composer-status[data-tone="info"]')
          .waitFor({ state: "hidden" });
        await page.screenshot({ path: path.join(artifactDir, "reconnected.png") });
        expect(await open()).toBe(false);
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );
});
