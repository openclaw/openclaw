import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  openSessionMenuSubmenu,
  sessionsListResponse,
  waitForPatch,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();
const homeKey = "agent:main:main";
const sessionKey = "agent:main:dashboard:header-lineage";

suite.define(() => {
  it.each([
    { name: "ordinary worktree", lineage: {}, independent: true },
    { name: "explicit child", lineage: { parentSessionId: "home-generation" }, independent: false },
    { name: "spawned child", lineage: { spawnedBy: homeKey, spawnDepth: 1 }, independent: false },
    {
      name: "fork",
      lineage: { forkSource: { sessionKey: homeKey, sessionId: "home-generation" } },
      independent: false,
    },
  ])("respects $name placement in the actual chat header", async ({ lineage, independent }) => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    const session = sessionRow(sessionKey, "Header lineage", 2, {
      createdVia: "operator",
      spawnDepth: 0,
      parentSessionKey: homeKey,
      spawnedWorkspaceDir: "/workspace/header-lineage",
      worktree: {
        id: "header-worktree",
        branch: "openclaw/header-lineage",
        repoRoot: "/workspace",
      },
      ...lineage,
    });
    const gateway = await installMockGateway(page, {
      sessionKey,
      sessionInfo: session,
      historyMessages: [{ role: "assistant", content: "Retained conversation." }],
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow(homeKey, "Home parent", 1, { sessionId: "home-generation" }),
          session,
          sessionRow("agent:main:dashboard:group-member", "Group member", 0, {
            category: "Projects",
          }),
        ]),
      },
    });
    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const header = page.locator(".chat-pane-cache__pane--visible .chat-pane__header");
      await header
        .locator(".chat-pane__parent-session")
        .getByText("Home parent", { exact: true })
        .waitFor();
      const actions = header.getByRole("button", { name: "Actions for Header lineage" });
      await actions.click();
      const menu = header.locator("openclaw-chat-header-session-menu");
      await page.getByRole("menu", { name: "Actions for Header lineage" }).waitFor();
      expect(await menu.getByText("Pin session", { exact: true }).count()).toBe(
        Number(independent),
      );
      expect(await menu.getByText("Move to group", { exact: true }).count()).toBe(
        Number(independent),
      );
      if (!independent) {
        return;
      }

      await menu.getByText("Pin session", { exact: true }).click();
      expect(
        (await waitForPatch(gateway, (params) => params.pinned === true)).params,
      ).toMatchObject({
        key: sessionKey,
        pinned: true,
        expectedSessionId: session.sessionId,
      });
      await actions.click();
      await menu.getByText("Unpin session", { exact: true }).click();
      await waitForPatch(gateway, (params) => params.pinned === false);
      await actions.click();
      await openSessionMenuSubmenu(page, "Move to group");
      await menu.locator('wa-dropdown-item[value="move-to-group:Projects"]').click();
      expect(
        (await waitForPatch(gateway, (params) => params.category === "Projects")).params,
      ).toMatchObject({
        key: sessionKey,
        category: "Projects",
        expectedSessionId: session.sessionId,
      });
      await expect
        .poll(() =>
          page
            .locator('[data-session-section="category:Projects"]')
            .locator(`[data-session-key="${sessionKey}"]`)
            .count(),
        )
        .toBe(1);
      expect(new URL(page.url()).pathname).toBe(
        new URL(controlUiSessionUrl(suite.server.baseUrl, sessionKey)).pathname,
      );
      await header
        .locator(".chat-pane__parent-session")
        .getByText("Home parent", { exact: true })
        .waitFor();
      await page.getByText("Retained conversation.", { exact: true }).waitFor();
    } finally {
      await context.close();
    }
  });
});
