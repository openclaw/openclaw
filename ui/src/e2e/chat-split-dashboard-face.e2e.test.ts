import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import {
  board,
  dashboardLayout,
  seedChatSettings,
  splitColumns,
  splitTranscripts,
} from "./chat-layout-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Split Dashboard face" });
suite.define(() => {
  it.each<{
    action: "focus" | "close";
    sourceFace: "chat" | "dashboard";
    targetFace: "chat" | "dashboard";
    legacy?: boolean;
    revisitChat?: boolean;
  }>([
    { action: "focus", sourceFace: "dashboard", targetFace: "chat" },
    { action: "close", sourceFace: "dashboard", targetFace: "chat" },
    { action: "focus", sourceFace: "chat", targetFace: "dashboard" },
    { action: "focus", sourceFace: "dashboard", targetFace: "chat", legacy: true },
    { action: "focus", sourceFace: "chat", targetFace: "dashboard", revisitChat: true },
  ])(
    "opens shared $targetFace after $action while keeping local intent (saved layout: $legacy, explicit Chat: $revisitChat)",
    async ({ action, sourceFace, targetFace, legacy = false, revisitChat = false }) => {
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
        await seedChatSettings(page, suite.server.baseUrl, {
          chatSplitLayout: splitColumns(rows, revisitChat ? 1 : 0),
          ...(legacy
            ? {
                sidebarSessionLayouts: {
                  [rows[1].key]: dashboardLayout("saved", "board", false),
                },
              }
            : {}),
        });
        const gateway = await installMockGateway(page, {
          sessionKey: rows[0].key,
          sessions: rows,
          featureMethods: [...defaultControlUiFeatureMethods, "board.get"],
          methodResponses: {
            "board.get": {
              cases: rows.map((row) => ({
                match: { sessionKey: row.key },
                response: board(row.key),
              })),
            },
          },
          sessionTranscripts: splitTranscripts(rows),
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
        const composer = beta.locator(".agent-chat__composer-combobox textarea");
        const draft = await composer.inputValue();
        if (revisitChat) {
          await alpha.locator(".chat-pane__header").click();
          await page.waitForURL((url) => url.pathname === "/chat/main/face-alpha");
        }
        if (action === "focus") {
          await beta.locator(".chat-pane__header").click();
        } else {
          await selectChatLayoutAction(alpha, "Close pane");
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
        expect(errors).toEqual([]);
        expect(await gateway.getRequests("chat.send")).toEqual([]);
        expect(await composer.inputValue()).toBe(draft);
        expect(await gateway.getRequests("sessions.patch")).toEqual([]);
      });
    },
  );
});
