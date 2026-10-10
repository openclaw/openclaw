import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  controlUiBundledSettingsStorageKey,
  defaultControlUiFeatureMethods,
} from "../test-helpers/control-ui-e2e.ts";
import { openChatDetails } from "./chat-details.test-support.ts";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";
import { openProgressHomeDock } from "./session-progress-home.test-support.ts";

const suite = createChatFlowE2eSuite();

async function scrollTranscriptUp(page: Page, thread: Locator, distance: number) {
  const before = await thread.evaluate((element) => element.scrollTop);
  const wheel = await thread.evaluateHandle((element) => {
    const controller = new AbortController();
    return {
      // Layout can move the offset before Chromium delivers the wheel event.
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
    await expect.poll(() => thread.evaluate((element) => element.scrollTop)).toBeLessThan(before);
    return {
      requested: distance,
      before,
      after: await thread.evaluate((element) => element.scrollTop),
    };
  } finally {
    await wheel.evaluate((state) => state.cancel());
    await wheel.dispose();
  }
}

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
    featureMethods: [...defaultControlUiFeatureMethods, "chat.history", "chat.send"],
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
  it("keeps Details choices through transcript input, reconnect, navigation, and scope reset", async () => {
    const context = await suite.newBrowserContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const sessionKey = "agent:main:main";
    const gateway = await installProgressGateway(page, sessionKey);
    const card = page.locator('[data-progress-card-placement="details"]');
    const panel = page.locator(".chat-details:popover-open");
    const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");
    const open = () => card.evaluate((element) => (element as HTMLDetailsElement).open);
    const sidebar = page.locator("openclaw-app-sidebar");
    const openSettings = async () => {
      await sidebar.locator(".sidebar-identity-card").click();
      await sidebar
        .locator("wa-dropdown.sidebar-identity-menu")
        .getByRole("menuitem", { exact: true, name: "Settings" })
        .click();
    };
    try {
      await page.goto(suite.server.baseUrl + "chat");
      await card.waitFor({ state: "attached" });
      expect(await panel.count()).toBe(0);
      expect(await page.locator('[data-progress-card-placement="composer"]').count()).toBe(0);
      await openChatDetails(page);
      await waitForChatScrollIdle(page);
      expect(await open()).toBe(true);
      // Wheel input outside the popover does not close it or its manual disclosure.
      const bounds = await thread.boundingBox();
      await page.mouse.move(bounds!.x + 8, bounds!.y + 80);
      await scrollTranscriptUp(page, thread, 700);
      await waitForChatScrollIdle(page);
      expect(await panel.isVisible()).toBe(true);
      expect(await open()).toBe(true);
      await card.locator("summary").press("Enter");
      expect(await open()).toBe(false);
      const retainedCard = await card.elementHandle();
      await gateway.setOnline(false);
      const offline = page.locator(".agent-chat__input--offline");
      await offline.waitFor();
      expect(await retainedCard!.evaluate((element) => element.isConnected)).toBe(true);
      expect(await open()).toBe(false);
      await gateway.setOnline(true);
      await offline.waitFor({ state: "hidden" });
      expect(await retainedCard!.evaluate((element) => element.isConnected)).toBe(true);
      expect(await open()).toBe(false);
      await page.locator('.chat-scroll-to-bottom[data-visible="true"]').click();
      await waitForChatScrollIdle(page);
      expect(await panel.count()).toBe(0);
      await gateway.emitChatFinal({
        sessionKey,
        runId: "progress-run",
        text: "Progress is complete.",
      });
      await page
        .locator(".chat-bubble")
        .getByText("Progress is complete.", { exact: true })
        .waitFor();
      expect(await panel.count()).toBe(0);
      await openChatDetails(page);
      expect(await open()).toBe(false);
      await card.locator("summary").press("Space");
      expect(await open()).toBe(true);
      const retainedPane = await page.locator("openclaw-chat-pane").elementHandle();
      await openSettings();
      await page.locator("openclaw-chat-pane").waitFor({ state: "hidden" });
      expect(await retainedPane!.evaluate((element) => element.isConnected)).toBe(true);
      expect(await panel.count()).toBe(0);
      await page.goBack();
      await openChatDetails(page);
      expect(await open()).toBe(true);
      await card.locator("summary").click();
      expect(await open()).toBe(false);
      await openSettings();
      await page.locator("openclaw-chat-pane").waitFor({ state: "hidden" });
      await page.goBack();
      expect(await panel.count()).toBe(0);
      await openChatDetails(page);
      expect(await open()).toBe(false);
      await page.reload();
      await card.waitFor({ state: "attached" });
      expect(await panel.count()).toBe(0);
      await openChatDetails(page);
      expect(await open()).toBe(true);
      await card.locator("summary").click();
      await openSettings();
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
      await card.waitFor({ state: "attached" });
      expect(await panel.count()).toBe(0);
      await openChatDetails(page);
      expect(await open()).toBe(true);
      await retainedCard!.dispose();
      await retainedPane!.dispose();
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it.each(["open", "closed"] as const)(
    "keeps a manually %s Details card after resolving a stored short-name pane through reconnect",
    async (choice) => {
      const artifactDir = createControlUiE2eArtifactDir("session-progress-reconnect-" + choice);
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
      const pane = page
        .locator(".chat-split-view__cell")
        .nth(1)
        .locator('openclaw-chat-pane[aria-hidden="false"]');
      const card = pane.locator('[data-progress-card-placement="details"]');
      const open = () => card.evaluate((element) => (element as HTMLDetailsElement).open);
      try {
        await page.goto(suite.server.baseUrl + "chat");
        await card.waitFor({ state: "attached" });
        // Activate the seeded pane before opening Details: activation resolves its
        // short key, and that identity change intentionally closes an open popover.
        await pane.locator(".agent-chat__composer-combobox textarea").click();
        await expect
          .poll(() =>
            pane.evaluate(
              (element) => (element as HTMLElement & { sessionKey: string }).sessionKey,
            ),
          )
          .toBe("agent:main:notes");
        await openChatDetails(pane);
        const retainedCard = await card.elementHandle();
        await gateway.setOnline(false);
        await pane.locator(".agent-chat__input--offline").waitFor();
        // Disconnect clears selected-session metadata, so reopen the public
        // popover before sending keyboard input to the retained card.
        await openChatDetails(pane);
        const summary = card.locator("summary");
        await summary.waitFor({ state: "visible" });
        expect(await pane.locator(".chat-details:popover-open").isVisible()).toBe(true);
        // Both choices are made while disconnected, not inferred from a default
        // or another pane's earlier presentation of the same card lifetime.
        const initialOpen = await open();
        await summary.focus();
        expect(await summary.evaluate((element) => document.activeElement === element)).toBe(true);
        await summary.press("Enter");
        await expect.poll(open).toBe(!initialOpen);
        if (initialOpen === (choice === "open")) {
          await summary.press("Space");
        }
        await expect.poll(open).toBe(choice === "open");
        await page.screenshot({ path: path.join(artifactDir, "disconnected.png") });
        await gateway.setOnline(true);
        await pane.locator(".agent-chat__input--offline").waitFor({ state: "hidden" });
        expect(await retainedCard!.evaluate((element) => element.isConnected)).toBe(true);
        await openChatDetails(pane);
        await page.screenshot({ path: path.join(artifactDir, "reconnected.png") });
        expect(await open()).toBe(choice === "open");
        expect(
          await pane.evaluate(
            (element) => (element as HTMLElement & { sessionKey: string }).sessionKey,
          ),
        ).toBe("agent:main:notes");
        await retainedCard!.dispose();
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );

  it("retains automatic collapse, escalating reopen, and pinning in the compact Home dock", async () => {
    const artifactDir = createControlUiE2eArtifactDir("session-progress-home-disclosure");
    const context = await suite.newBrowserContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const gateway = await installProgressGateway(page, "agent:main:main");
    const home = page.locator("openclaw-home-session");
    const card = home.locator('[data-progress-card-placement="composer"]');
    const thread = home.locator(".chat-thread");
    const open = () => card.evaluate((element) => (element as HTMLDetailsElement).open);
    const offsets: Array<{ requested: number; before: number; after: number }> = [];
    const gestures = async (count: number, distance: number) => {
      await thread.hover();
      for (let index = 0; index < count; index++) {
        if (index) {
          await page.waitForTimeout(201); // Separate native input bursts.
        }
        offsets.push(await scrollTranscriptUp(page, thread, distance));
      }
      await page.waitForTimeout(300); // The production disclosure settlement boundary.
    };
    try {
      // Home cannot dock beside the same Home chat; start on the public New route.
      await page.goto(suite.server.baseUrl + "new");
      await openProgressHomeDock(page);
      await card.waitFor();
      await gateway.waitForRequest("chat.startup", { match: { sessionKey: "agent:main:main" } });
      await expect
        .poll(() =>
          thread.evaluate(
            (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
          ),
        )
        .toBeLessThan(2);
      expect(await open()).toBe(true);
      await gestures(1, 500);
      expect(await open()).toBe(true);
      await gestures(1, 200);
      await expect.poll(open).toBe(false);
      const retained = await card.elementHandle();
      await gateway.setOnline(false);
      await home.locator(".agent-chat__input--offline").waitFor();
      expect(await open()).toBe(false);
      await gateway.setOnline(true);
      await home.locator(".agent-chat__input--offline").waitFor({ state: "hidden" });
      expect(await retained!.evaluate((element) => element.isConnected)).toBe(true);
      expect(await open()).toBe(false);
      await card.locator("summary").press("Enter");
      await gestures(2, 320);
      expect(await open()).toBe(true);
      await gestures(1, 100);
      await expect.poll(open).toBe(false);
      await card.locator("summary").press("Space");
      await gestures(4, 320);
      expect(await open()).toBe(true);
      await page.getByRole("button", { name: "Close assistant sidebar", exact: true }).click();
      await home.waitFor({ state: "hidden" });
      await openProgressHomeDock(page);
      await card.waitFor();
      expect(await open()).toBe(true);
      // A new visit retains the manual choice, but resets escalation and pinning.
      await gestures(2, 320);
      await expect.poll(open).toBe(false);
      await card.locator("summary").click();
      await card.locator("summary").click();
      await gestures(3, 320);
      expect(await open()).toBe(false);
      await retained!.dispose();
    } finally {
      await writeFile(
        path.join(artifactDir, "wheel-offsets.json"),
        JSON.stringify(offsets, null, 2),
      );
      await suite.closeBrowserContext(context);
    }
  });
});
