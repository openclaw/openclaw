import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import {
  controlUiBundledSettingsStorageKey,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

// Selecting another visible conversation must use its own face and saved arrangement.
// Existing close-focus coverage seeds a legacy Dashboard layout; this target has none.
// Restored split settings are public browser state; actions use ordinary clicks.
const suite = createControlUiE2eSuite({ name: "Split Dashboard face" });
suite.define(() => {
  it.each([
    {
      action: "focus",
      sourceFace: "dashboard",
      targetFace: "chat",
      legacy: false,
      revisitChat: false,
    },
    {
      action: "close",
      sourceFace: "dashboard",
      targetFace: "chat",
      legacy: false,
      revisitChat: false,
    },
    {
      action: "focus",
      sourceFace: "chat",
      targetFace: "dashboard",
      legacy: false,
      revisitChat: false,
    },
    {
      action: "focus",
      sourceFace: "dashboard",
      targetFace: "chat",
      legacy: true,
      revisitChat: false,
    },
    {
      action: "focus",
      sourceFace: "chat",
      targetFace: "dashboard",
      legacy: false,
      revisitChat: true,
    },
  ] as const)(
    "opens shared $targetFace after $action while keeping local intent (saved layout: $legacy, explicit Chat: $revisitChat)",
    async ({ action, sourceFace, targetFace, legacy, revisitChat }) => {
      const expectedFace = legacy ? "dashboard" : revisitChat ? "chat" : targetFace;
      await suite.withPage({ viewport: { width: 2400, height: 1000 } }, async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const rows = [
          {
            key: "agent:main:face-alpha",
            kind: "direct",
            label: "Alpha",
            boardFace: sourceFace,
            updatedAt: 20,
          },
          {
            key: "agent:main:face-beta",
            kind: "direct",
            label: "Beta",
            boardFace: targetFace,
            updatedAt: 10,
          },
        ] satisfies [GatewaySessionRow, GatewaySessionRow];
        await page.addInitScript(
          ({ storageKey, sessions, savedLayout, revisitChat: startOnTarget }) => {
            localStorage.setItem(
              storageKey,
              JSON.stringify({
                ...(savedLayout
                  ? {
                      sidebarSessionLayouts: {
                        [sessions[1].key]: {
                          columns: [
                            {
                              id: "saved",
                              side: "right",
                              panels: [{ id: "board", slot: "dashboard" }],
                              activePanelId: "board",
                              width: 480,
                              height: 360,
                            },
                          ],
                          open: true,
                          expanded: false,
                        },
                      },
                    }
                  : {}),
                chatSplitLayout: {
                  activePaneId: startOnTarget ? "p2" : "p1",
                  columnWeights: [0.5, 0.5],
                  columns: sessions.map((row, index) => ({
                    id: `c${index + 1}`,
                    paneWeights: [1],
                    panes: [{ id: `p${index + 1}`, sessionKey: row.key }],
                  })),
                },
              }),
            );
          },
          {
            storageKey: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
            sessions: rows,
            savedLayout: legacy,
            revisitChat,
          },
        );
        const gateway = await installMockGateway(page, {
          sessionKey: rows[0].key,
          sessions: rows,
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "chat.history",
            "chat.send",
            "board.get",
          ],
          methodResponses: {
            "board.get": {
              cases: rows.map((row) => ({
                match: { sessionKey: row.key },
                response: {
                  sessionKey: row.key,
                  revision: 1,
                  tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
                  widgets: [],
                },
              })),
            },
          },
          sessionTranscripts: Object.fromEntries(
            rows.map((row) => [
              row.key,
              {
                messages: [
                  { role: "assistant", content: `Conversation ${row.label}`, timestamp: 1 },
                ],
              },
            ]),
          ),
        });
        await page.goto(
          `${suite.server.baseUrl}${revisitChat ? "chat/main/face-beta" : `${sourceFace}/main/face-alpha`}`,
        );
        const panes = page.locator('openclaw-chat-page openclaw-chat-pane[aria-hidden="false"]');
        const alpha = panes.filter({ hasText: "Conversation Alpha" });
        const beta = panes.filter({ hasText: "Conversation Beta" });
        const dashboard = (pane: typeof beta) =>
          pane.locator('[data-panel-slot="dashboard"]:visible');
        await expect.poll(() => panes.count()).toBe(2);
        await alpha.locator(".chat-thread").waitFor();
        await beta.locator(".chat-thread").waitFor();
        await expect.poll(() => dashboard(alpha).count()).toBe(sourceFace === "dashboard" ? 1 : 0);
        await expect.poll(() => dashboard(beta).count()).toBe(legacy ? 1 : 0);
        // Both snapshots are already loaded and never change during selection.
        await expect
          .poll(
            async () =>
              (await gateway.getRequests("board.get", { sessionKey: rows[1].key })).length,
          )
          .toBeGreaterThan(0);
        const observe = async () => ({
          url: page.url(),
          betaDashboard: await dashboard(beta).count(),
          betaDraft: await beta.locator(".agent-chat__composer-combobox textarea").inputValue(),
          betaClass: await beta.getAttribute("class"),
          patches: await gateway.getRequests("sessions.patch"),
          sends: await gateway.getRequests("chat.send"),
          errors: [...errors],
        });
        const before = await observe();
        await page.screenshot({ path: path.join(suite.artifactDir, "before.png") });
        if (revisitChat) {
          await alpha.locator(".chat-pane__header").click();
          await page.waitForURL((url) => url.pathname === "/chat/main/face-alpha");
        }
        if (action === "focus") {
          await beta.locator(".chat-pane__header").click();
        } else {
          await alpha.locator(".chat-pane__close-pane").click();
        }
        await expect.poll(() => page.url()).toContain("/main/face-beta");
        await expect
          .poll(() => beta.getAttribute("class"))
          .toContain("chat-pane-cache__pane--active");
        await expect
          .poll(async () => ({
            pathname: new URL(page.url()).pathname,
            dashboard: await dashboard(beta).count(),
          }))
          .toEqual({
            pathname: `/${expectedFace}/main/face-beta`,
            dashboard: expectedFace === "dashboard" ? 1 : 0,
          });
        const after = await observe();
        await page.screenshot({ path: path.join(suite.artifactDir, "after.png") });
        await writeFile(
          path.join(suite.artifactDir, "observations.json"),
          JSON.stringify(
            { action, sourceFace, targetFace, legacy, revisitChat, before, after },
            null,
            2,
          ),
        );
        expect(after.errors).toEqual([]);
        expect(after.sends).toEqual([]);
        expect(after.betaDraft).toBe(before.betaDraft);
        expect(after.betaDashboard).toBe(expectedFace === "dashboard" ? 1 : 0);
        expect(new URL(after.url).pathname).toBe(`/${expectedFace}/main/face-beta`);
        expect(after.patches).toEqual([]);
      });
    },
  );
});
