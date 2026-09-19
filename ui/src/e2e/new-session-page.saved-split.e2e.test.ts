import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { UiSettings } from "../app/settings.ts";
import type { ChatSplitLayout } from "../pages/chat/split-layout-types.ts";
import { composerValue, fillComposer } from "../test-helpers/composer-editor.ts";
import {
  controlUiBundledGatewayUrl,
  controlUiBundledSettingsStorageKey,
  navigateToControlUiSession,
} from "../test-helpers/control-ui-e2e.ts";
import {
  controlUiSessionPath,
  createNewSessionPageE2eSuite,
  installMockGateway,
  navigateInApp,
  waitForCommittedChatRoute,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const leftKey = "agent:main:saved-left";
const rightKey = "agent:main:saved-right";
const confirmedKey = "agent:main:confirmed-split-thread";
const savedLayout: ChatSplitLayout = {
  activePaneId: "p2",
  columnWeights: [0.4, 0.6],
  columns: [
    { id: "c1", paneWeights: [1], panes: [{ id: "p1", sessionKey: leftKey }] },
    { id: "c2", paneWeights: [1], panes: [{ id: "p2", sessionKey: rightKey }] },
  ],
};

function readSaved(page: Page, storageKey: string) {
  return page.evaluate((key) => {
    // This is the real persisted settings document, not a mocked settings owner.
    const settings = JSON.parse(localStorage.getItem(key) ?? "null") as {
      chatSplitLayout?: ChatSplitLayout;
      sessionsByGateway?: Record<string, Pick<UiSettings, "sessionKey" | "lastActiveSessionKey">>;
    } | null;
    const scope = key.slice("openclaw.control.settings.v1:".length);
    const selection = settings?.sessionsByGateway?.[scope];
    return {
      chatSplitLayout: settings?.chatSplitLayout,
      sessionKey: selection?.sessionKey,
      lastActiveSessionKey: selection?.lastActiveSessionKey,
    };
  }, storageKey);
}

suite.define(() => {
  it("preserves an existing split across pending creation, rejection and reload, then adopts only the confirmed key", async () => {
    await suite.withPage({ viewport: { width: 1600, height: 1000 } }, async ({ page }) => {
      const storageKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
      await page.addInitScript(
        ({ key, scope, layout, selectedKey }) => {
          // Seed once: reload must consume the application's actual persisted result.
          if (sessionStorage.getItem("saved-split-fixture-seeded")) {
            return;
          }
          sessionStorage.setItem("saved-split-fixture-seeded", "true");
          localStorage.setItem(
            key,
            JSON.stringify({
              chatSplitLayout: layout,
              sessionsByGateway: {
                [scope]: { sessionKey: selectedKey, lastActiveSessionKey: selectedKey },
              },
            }),
          );
        },
        {
          key: storageKey,
          scope: controlUiBundledGatewayUrl(suite.server.baseUrl),
          layout: savedLayout,
          selectedKey: rightKey,
        },
      );
      const gateway = await installMockGateway(page, {
        sessionKey: rightKey,
        sessions: [leftKey, rightKey].map((key) => ({ key, kind: "direct", updatedAt: 1 })),
      });
      await page.goto(`${suite.server.baseUrl}new?agent=main#saved-split`);
      const composer = page.locator(".new-session-page__message");
      await fillComposer(composer, "preserve my saved split");
      const before = {
        chatSplitLayout: savedLayout,
        sessionKey: rightKey,
        lastActiveSessionKey: rightKey,
      };
      expect(await readSaved(page, storageKey)).toEqual(before);
      const draftUrl = page.url();
      await gateway.deferNext("sessions.create");
      await page.getByRole("button", { name: "Start session", exact: true }).click();
      await gateway.waitForRequest("sessions.create");
      await expect
        .poll(() => page.locator(".chat-thread").textContent())
        .toContain("preserve my saved split");
      expect(await readSaved(page, storageKey)).toEqual(before);
      expect(await page.locator("openclaw-chat-pane").count()).toBe(0);
      expect(await gateway.getRequests("chat.startup")).toHaveLength(0);
      expect(page.url()).toBe(draftUrl);

      await gateway.rejectDeferred("sessions.create", {
        code: "UNAVAILABLE",
        message: "Synthetic saved-layout admission refusal",
      });
      await expect.poll(() => composerValue(composer)).toBe("preserve my saved split");
      expect(await readSaved(page, storageKey)).toEqual(before);
      expect(page.url()).toBe(draftUrl);
      await page.reload();
      await composer.waitFor({ state: "visible" });
      expect(await readSaved(page, storageKey)).toEqual(before);

      await navigateToControlUiSession(page, rightKey);
      await waitForCommittedChatRoute(page);
      await expect.poll(() => page.locator(".chat-split-view__cell").count()).toBe(2);
      expect(await readSaved(page, storageKey)).toEqual(before);
      await navigateInApp(page, "new-session", "?agent=main");
      await fillComposer(composer, "adopt the confirmed session only");
      await gateway.deferNext("sessions.create");
      await page.getByRole("button", { name: "Start session", exact: true }).click();
      const request = await gateway.waitForRequest("sessions.create");
      expect(request.params).toHaveProperty("key", expect.not.stringContaining(confirmedKey));
      await expect
        .poll(() => page.locator("openclaw-pending-session-create").textContent())
        .toContain("adopt the confirmed session only");
      expect(await readSaved(page, storageKey)).toEqual(before);
      await gateway.resolveDeferred("sessions.create", {
        key: confirmedKey,
        runStarted: true,
        runId: "confirmed-split-run",
      });
      await waitForCommittedChatRoute(page);
      expect(new URL(page.url()).pathname).toBe(controlUiSessionPath(confirmedKey));
      const confirmedLayout = {
        ...savedLayout,
        columns: [
          savedLayout.columns[0],
          { id: "c2", paneWeights: [1], panes: [{ id: "p2", sessionKey: confirmedKey }] },
        ],
      };
      await expect
        .poll(() => readSaved(page, storageKey))
        .toEqual({
          chatSplitLayout: confirmedLayout,
          sessionKey: confirmedKey,
          lastActiveSessionKey: confirmedKey,
        });
      await expect.poll(() => page.locator(".chat-split-view__cell").count()).toBe(2);
      await gateway.waitForRequest("chat.startup", { match: { sessionKey: confirmedKey } });
    });
  });
});
