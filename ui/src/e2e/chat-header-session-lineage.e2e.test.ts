import { expect, it } from "vitest";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  openSessionMenuSubmenu,
  sessionsListResponse,
  waitForPatch,
} from "./session-management.test-support.ts";
import { installPreferenceServer } from "./sidebar-assertions.test-support.ts";

const suite = createSessionManagementE2eSuite();
const homeKey = "agent:main:main";
const sessionKey = "agent:main:dashboard:header-lineage";
suite.define(() => {
  it.each([
    ["ordinary worktree", {}, true],
    ["explicit child", { parentSessionId: "home-generation" }, false],
    ["spawned child", { spawnedBy: homeKey, spawnDepth: 1 }, false],
    ["fork", { forkSource: { sessionKey: homeKey, sessionId: "home-generation" } }, false],
  ] as const)(
    "respects %s placement in the actual chat header",
    async (_name, lineage, independent) => {
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const session = sessionRow(sessionKey, "Header lineage", 2, {
          createdVia: "operator",
          owner: { actor: { type: "human", id: "profile-lineage", label: "Lineage owner" } },
          spawnDepth: 0,
          parentSessionKey: homeKey,
          spawnedWorkspaceDir: "/workspace/header-lineage",
          worktree: { id: "header-worktree", branch: "feature", repoRoot: "/workspace" },
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
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await gateway.waitForRequest("connect");
        await installPreferenceServer(page, { "ui.railShortcuts": [] });
        await gateway.resolveDeferred("connect");
        await gateway.waitForRequest("users.prefs.get");
        const header = page.locator(".chat-pane-cache__pane--visible .chat-pane__header");
        const parent = header
          .locator(".chat-pane__parent-session")
          .getByText("Home parent", { exact: true });
        const expectConversation = async () => {
          await parent.waitFor();
          await page.getByText("Retained conversation.", { exact: true }).waitFor();
        };
        const expectPatch = async (field: "sidebarRoot" | "category", value: boolean | string) => {
          expect(
            (await waitForPatch(gateway, (params) => params[field] === value)).params,
          ).toMatchObject({
            key: sessionKey,
            expectedSessionId: session.sessionId,
            [field]: value,
          });
        };
        await parent.waitFor();
        const actions = header.getByRole("button", { name: "Actions for Header lineage" });
        await actions.click();
        const menu = header.locator("openclaw-chat-header-session-menu");
        await page.getByRole("menu", { name: "Actions for Header lineage" }).waitFor();
        await menu.getByText("Move to group", { exact: true }).waitFor();
        const count = (name: string) => menu.getByText(name, { exact: true }).count();
        expect(await count("Pin session")).toBe(Number(independent));
        expect(await count("Move to group")).toBe(1);
        expect(await count("Move to top level")).toBe(Number(!independent));
        if (!independent) {
          await menu.getByText("Move to top level", { exact: true }).click();
          await expectPatch("sidebarRoot", true);
          await expectConversation();
          return;
        }

        const pin = page.locator(
          `[data-session-section="pinned"] .sidebar-recent-session[data-session-key="${sessionKey}"]`,
        );
        const shortcuts = [`session:${sessionKey}`];
        for (const [after, name] of ["Pin session", "Unpin session"].entries()) {
          if (after) {
            await actions.click();
          }
          await menu.getByText(name, { exact: true }).click();
          expect((await gateway.waitForRequest("users.prefs.set", { after })).params).toEqual({
            entries: { "ui.railShortcuts": after ? [] : shortcuts },
            expectedEntries: { "ui.railShortcuts": after ? shortcuts : [] },
          });
          await pin.waitFor({ state: after ? "detached" : "visible" });
          expect(await gateway.getRequests("sessions.patch")).toEqual([]);
        }
        expect(await gateway.getRequests("config.patch")).toEqual([]);
        await actions.click();
        await openSessionMenuSubmenu(page, "Move to group");
        await menu.getByRole("menuitemradio", { name: "Projects", exact: true }).click();
        await expectPatch("category", "Projects");
        const grouped = page.locator(
          `[data-session-section="category:Projects"] [data-session-key="${sessionKey}"]`,
        );
        await expect.poll(() => grouped.count()).toBe(1);
        expect(new URL(page.url()).pathname).toBe(
          new URL(controlUiSessionUrl(suite.server.baseUrl, sessionKey)).pathname,
        );
        await expectConversation();
      });
    },
  );
});
