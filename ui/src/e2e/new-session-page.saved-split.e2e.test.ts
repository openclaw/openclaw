import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { PersistedUiSettings } from "../app/settings-storage-types.ts";
import type { ChatSplitLayout } from "../pages/chat/split-layout-types.ts";
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
  pollCount,
  pollText,
  pollValue,
  waitForCommittedChatRoute,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const leftKey = "agent:main:saved-left";
const rightKey = "agent:main:saved-right";
const confirmedKey = "agent:main:confirmed-split-thread";
const selection = (sessionKey: string) => ({ sessionKey, lastActiveSessionKey: sessionKey });
const savedLayout = (left: string, right: string): ChatSplitLayout => ({
  activePaneId: "p2",
  columnWeights: [0.4, 0.6],
  columns: [
    { id: "c1", paneWeights: [1], panes: [{ id: "p1", sessionKey: left }] },
    { id: "c2", paneWeights: [1], panes: [{ id: "p2", sessionKey: right }] },
  ],
});

function readSaved(page: Page, storageKey: string) {
  return page.evaluate((key) => {
    const settings = JSON.parse(
      localStorage.getItem(key) ?? "null",
    ) as Partial<PersistedUiSettings> | null;
    const scope = key.slice("openclaw.control.settings.v1:".length);
    const selected = settings?.sessionsByGateway?.[scope];
    return {
      chatSplitLayout: settings?.chatSplitLayout,
      sessionKey: selected?.sessionKey,
      lastActiveSessionKey: selected?.lastActiveSessionKey,
    };
  }, storageKey);
}

suite.define(() => {
  it.each([false, true])(
    "preserves an existing split across pending creation, rejection and reload, then adopts only the confirmed key (unbound: %s)",
    async (unbound) => {
      const initialLayout = savedLayout(unbound ? "global" : leftKey, rightKey);
      await suite.withPage({ viewport: { width: 1600, height: 1000 } }, async ({ page }) => {
        const storageKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
        await page.addInitScript(
          ({ key, settings }) => {
            // Seed once: reload must consume the application's actual persisted result.
            if (sessionStorage.getItem("saved-split-fixture-seeded")) {
              return;
            }
            sessionStorage.setItem("saved-split-fixture-seeded", "true");
            localStorage.setItem(key, settings);
          },
          {
            key: storageKey,
            settings: JSON.stringify({
              chatSplitLayout: initialLayout,
              sessionsByGateway: {
                [controlUiBundledGatewayUrl(suite.server.baseUrl)]: selection(rightKey),
              },
            }),
          },
        );
        const gateway = await installMockGateway(page, {
          sessionKey: rightKey,
          sessions: [leftKey, rightKey].map((key) => ({ key, kind: "direct", updatedAt: 1 })),
        });
        await page.goto(`${suite.server.baseUrl}new?agent=main#saved-split`);
        const composer = page.locator(".new-session-page__message");
        const pending = page.locator("openclaw-pending-session-create");
        const start = page.getByRole("button", { name: "Start session", exact: true });
        await composer.fill("preserve my saved split");
        const before = {
          chatSplitLayout: initialLayout,
          ...selection(rightKey),
        };
        expect(await readSaved(page, storageKey)).toEqual(before);
        const draftUrl = page.url();
        await gateway.deferNext("sessions.create");
        await start.click();
        await gateway.waitForRequest("sessions.create");
        await pollText(page.locator(".chat-thread")).toContain("preserve my saved split");
        await pending.locator(".chat-group.user .chat-bubble").click();
        expect(await pending.isVisible()).toBe(true);
        expect(await readSaved(page, storageKey)).toEqual(before);
        expect(await page.locator("openclaw-chat-pane").count()).toBe(0);
        expect(await gateway.getRequests("chat.startup")).toHaveLength(0);
        expect(page.url()).toBe(draftUrl);

        await gateway.rejectDeferred("sessions.create", {
          code: "UNAVAILABLE",
          message: "Synthetic saved-layout admission refusal",
        });
        await pollValue(composer).toBe("preserve my saved split");
        expect(await readSaved(page, storageKey)).toEqual(before);
        expect(page.url()).toBe(draftUrl);
        await page.reload();
        await composer.waitFor({ state: "visible" });
        expect(await readSaved(page, storageKey)).toEqual(before);

        await navigateToControlUiSession(page, rightKey);
        await waitForCommittedChatRoute(page);
        await pollCount(page.locator(".chat-split-view__cell")).toBe(2);
        expect(await readSaved(page, storageKey)).toEqual(before);
        await navigateInApp(page, "new-session", "?agent=main");
        await composer.fill("adopt the confirmed session only");
        await gateway.deferNext("sessions.create");
        await start.click();
        const request = await gateway.waitForRequest("sessions.create");
        expect(request.params).toHaveProperty("key", expect.not.stringContaining(confirmedKey));
        await pollText(pending).toContain("adopt the confirmed session only");
        expect(await readSaved(page, storageKey)).toEqual(before);
        await gateway.resolveDeferred("sessions.create", {
          key: confirmedKey,
          runStarted: true,
          runId: "confirmed-split-run",
        });
        await waitForCommittedChatRoute(page);
        expect(new URL(page.url()).pathname).toBe(controlUiSessionPath(confirmedKey));
        await expect
          .poll(() => readSaved(page, storageKey))
          .toEqual({
            chatSplitLayout: savedLayout(unbound ? "global" : leftKey, confirmedKey),
            ...selection(confirmedKey),
          });
        await pollCount(page.locator(".chat-split-view__cell")).toBe(2);
        await gateway.waitForRequest("chat.startup", { match: { sessionKey: confirmedKey } });
      });
    },
  );
});
