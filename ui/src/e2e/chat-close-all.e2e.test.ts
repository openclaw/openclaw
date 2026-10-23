import { expect, it } from "vitest";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Close all sidebar tabs",
  trackBrowserContexts: true,
});

suite.define(() => {
  it("closes a Files preview and its host before returning to the panel launcher", async () => {
    const context = await suite.newBrowserContext({
      viewport: { width: 1440, height: 960 },
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    const sessionKey = "agent:main:close-all";
    const now = Date.now();
    await installMockGateway(page, {
      sessionKey,
      sessions: [createControlUiSessionRow(sessionKey, "Close all review", now)],
      operatorScopes: ["operator.admin", "operator.read", "operator.write", "operator.approvals"],
      historyMessages: [{ role: "assistant", content: "Review `notes.md`.", timestamp: now }],
      methodResponses: {
        "sessions.files.get": {
          sessionKey,
          root: "/workspace",
          file: {
            name: "notes.md",
            path: "notes.md",
            workspacePath: "notes.md",
            kind: "read",
            missing: false,
            previewKind: "text",
            contentEncoding: "utf8",
            content: "# Review notes\n\nAll changes are ready.\n",
            hash: "synthetic-close-all-notes",
          },
        },
      },
    });
    await page.goto(new URL(`/chat?session=${sessionKey}`, suite.server.baseUrl).href);
    await waitForControlUiRoute(page, { routeId: "chat" });
    await page.locator('a.markdown-file-link[data-file-path="notes.md"]').first().click();
    await page.getByText("All changes are ready.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Panel position", exact: true }).click();
    await page.locator('[data-value="close-all"]').filter({ visible: true }).click();
    // Closing the preview is only the first step; its Files host must also retire.
    await page.getByText("Quick access", { exact: true }).filter({ visible: true }).waitFor();
    expect(await page.locator(".sidebar-file-view:visible").count()).toBe(0);
    expect(await page.locator(".workspace-desktop:visible").count()).toBe(0);
  });
});
