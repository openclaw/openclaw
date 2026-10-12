import { expect, it } from "vitest";
import type { MockGatewayWindow } from "../test-helpers/control-ui-e2e-contract.ts";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e.ts";
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
      owner: { actor: { type: "human", id: "profile-lineage", label: "Lineage owner" } },
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
      heldMethods: ["connect"],
      presenceUsers: [{ self: true, id: "profile-lineage", name: "Lineage owner" }],
      featureMethods: [...defaultControlUiFeatureMethods, "users.prefs.get", "users.prefs.set"],
      sessionInfo: session,
      historyMessages: [{ role: "assistant", content: "Retained conversation." }],
      methodResponses: {
        "config.get": { config: {}, hash: "lineage-profile-config" },
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
      await gateway.waitForRequest("connect");
      await page.evaluate(() => {
        const mock = (window as MockGatewayWindow).openclawControlUiE2eGateway!;
        const entries: Record<string, unknown> = { "ui.railShortcuts": [] };
        mock.setRequestHandler("users.prefs.get", ({ respond }) =>
          respond({ status: "ok", entries }),
        );
        mock.setRequestHandler("users.prefs.set", ({ params, respond }) => {
          if (!params || typeof params !== "object" || !("entries" in params)) {
            throw new Error("Expected profile preference entries");
          }
          Object.assign(entries, params.entries);
          respond({ status: "ok" });
        });
      });
      await gateway.resolveDeferred("connect");
      await gateway.waitForRequest("users.prefs.get");
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
      expect(await menu.getByText("Move to group", { exact: true }).count()).toBe(1);
      expect(await menu.getByText("Move to top level", { exact: true }).count()).toBe(
        Number(!independent),
      );
      if (!independent) {
        await menu.getByText("Move to top level", { exact: true }).click();
        expect(
          (await waitForPatch(gateway, (params) => params.sidebarRoot === true)).params,
        ).toMatchObject({
          key: sessionKey,
          sidebarRoot: true,
          expectedSessionId: session.sessionId,
        });
        await header
          .locator(".chat-pane__parent-session")
          .getByText("Home parent", { exact: true })
          .waitFor();
        await page.getByText("Retained conversation.", { exact: true }).waitFor();
        return;
      }

      await menu.getByText("Pin session", { exact: true }).click();
      const pin = page.locator(`.sidebar-rail [data-sidebar-entry="session:${sessionKey}"]`);
      expect((await gateway.waitForRequest("users.prefs.set")).params).toEqual({
        entries: { "ui.railShortcuts": [`session:${sessionKey}`] },
        expectedEntries: { "ui.railShortcuts": [] },
      });
      await pin.waitFor();
      expect(await gateway.getRequests("sessions.patch")).toEqual([]);
      await actions.click();
      await menu.getByText("Unpin session", { exact: true }).click();
      expect((await gateway.waitForRequest("users.prefs.set", { after: 1 })).params).toEqual({
        entries: { "ui.railShortcuts": [] },
        expectedEntries: { "ui.railShortcuts": [`session:${sessionKey}`] },
      });
      await pin.waitFor({ state: "detached" });
      expect(await gateway.getRequests("sessions.patch")).toEqual([]);
      expect(await gateway.getRequests("config.patch")).toEqual([]);
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
