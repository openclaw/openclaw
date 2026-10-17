import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  navigateToControlUiSession,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import { button, menuItem, sessionPatch } from "./session-management.compact.test-support.ts";
import {
  activateSelfRemovingControl,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  openSessionMenuSubmenu,
  requireRecord,
  sessionsListResponse,
  submitInputDialog,
  waitForPatch,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();
const archived = sessionRow(
  "agent:main:archived-write-scope",
  "Archived write scope",
  Date.parse("2026-08-01T12:00:00.000Z"),
  { archived: true },
);

async function confirmDelete(page: import("playwright").Page) {
  await button(page.locator("openclaw-modal-dialog").last(), "Delete").click();
}

async function openArchivedPage(page: import("playwright").Page, operatorScopes: string[]) {
  const gateway = await installMockGateway(page, {
    featureMethods: ["chat.metadata", "chat.startup", "sessions.delete"],
    operatorScopes,
    sessionArchiveFiltering: true,
    methodResponses: {
      "sessions.delete": { deleted: true },
      "sessions.list": sessionsListResponse([archived]),
    },
  });
  await page.goto(`${suite.server.baseUrl}sessions?status=archived`);
  await button(page, "Filters", false).click();
  const deleteAll = button(page, /Delete all archived/, false);
  await deleteAll.waitFor();
  return { deleteAll, gateway };
}

suite.define(() => {
  it.each([
    { scope: "operator.sessions.read", name: "SESSION_READ", canOrganize: false },
    { scope: "operator.sessions.write", name: "SESSION_WRITE", canOrganize: true },
  ])(
    "$name reads shared history and limits organization to existing owned sessions",
    async ({ scope, canOrganize }) => {
      return suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const timestamp = Date.parse("2026-09-20T12:00:00.000Z");
        const shared = sessionRow("agent:main:shared-notes", "Shared notes", timestamp, {
          sharingRole: "member",
          visibility: "shared",
        });
        const own = sessionRow("agent:main:my-notes", "My workspace", timestamp - 60_000, {
          sharingRole: "owner",
          visibility: "shared",
        });
        const gateway = await installMockGateway(page, {
          operatorScopes: [scope],
          sessionKey: shared.key,
          sessions: [shared, own],
          sessionArchiveFiltering: true,
          agentModel: "openai/gpt-5.5",
          models: [{ id: "gpt-5.5", name: "GPT-5.5", provider: "openai", available: true }],
          presenceUsers: [{ self: true, id: "scope-reader", name: "Session reader" }],
          historyMessages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "Recorded project notes remain readable." }],
            },
          ],
        });

        const activePane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
        const historyText = activePane
          .getByRole("paragraph")
          .filter({ hasText: /^Recorded project notes remain readable\.$/u });
        const composer = activePane.locator(".agent-chat__composer-combobox > textarea");
        const send = activePane.locator("button.chat-send-btn--send");
        const model = activePane.locator("[data-chat-model-select]");
        const permission = activePane.locator("[data-chat-permission-select]");
        const menu = page.locator("openclaw-session-menu");
        const rename = menu.locator('[data-value="rename"]');
        const archive = menu.locator('[data-value="toggle-archived"]');
        const fork = menu.locator('[data-value="fork"]');
        const ownRow = page.locator(`.sidebar-recent-session[data-session-key="${own.key}"]`);
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, own.key));
        await historyText.waitFor();
        await ownRow.click({ button: "right" });
        await rename.waitFor();

        await page.keyboard.press("Escape");
        await navigateToControlUiSession(page, shared.key);
        await historyText.waitFor();

        await page.evaluate((url) => {
          history.pushState(null, "", url);
          dispatchEvent(new PopStateEvent("popstate"));
        }, `${suite.server.baseUrl}sessions`);
        await waitForControlUiRoute(page, { pathname: "/sessions", routeId: "sessions" });
        const detailsLabel = page.locator(".session-details-row").getByRole("textbox", {
          name: "Label",
          exact: true,
        });
        await page
          .locator(".session-data-row")
          .filter({ hasText: "Shared notes" })
          .locator(".session-details-toggle")
          .click();
        await detailsLabel.waitFor();
        expect(await detailsLabel.isDisabled()).toBe(true);
        await page
          .locator(".session-data-row")
          .filter({ hasText: "My workspace" })
          .locator(".session-details-toggle")
          .click();
        await detailsLabel.waitFor();

        expect(await detailsLabel.isEditable()).toBe(canOrganize);
        if (canOrganize) {
          await detailsLabel.fill("List workspace");
          await detailsLabel.press("Tab");
          await sessionPatch(gateway, own.key, { label: "List workspace" });
          const listRow = page.locator(".session-data-row").filter({ hasText: "List workspace" });
          await button(listRow, "Open session menu").click();
          await menuItem(menu, "Mark as unread").click();
          await sessionPatch(gateway, own.key, { unread: true });
        }
        await navigateToControlUiSession(page, shared.key);
        await historyText.waitFor();
        expect(await composer.isEditable()).toBe(false);
        expect(await send.isDisabled()).toBe(true);
        expect(await model.getAttribute("aria-disabled")).toBe("true");
        expect(await permission.isDisabled()).toBe(true);
        const create = page.locator(".sidebar-rail .sidebar-new-session");
        expect(await create.isDisabled()).toBe(!canOrganize);
        if (!canOrganize) {
          await create.click({ force: true });
          expect(new URL(page.url()).pathname).not.toBe("/new");
        }
        const sharedRow = page.locator(`.sidebar-recent-session[data-session-key="${shared.key}"]`);
        await sharedRow.click({ button: "right" });
        await rename.waitFor();
        expect(await rename.getAttribute("disabled")).not.toBeNull();
        expect(await archive.getAttribute("disabled")).not.toBeNull();
        expect(await fork.getAttribute("disabled")).not.toBeNull();
        expect(await menu.locator('[data-value="toggle-unread"]').isDisabled()).toBe(true);
        await rename.click({ force: true });
        await archive.click({ force: true });
        await page.keyboard.press("Escape");

        await navigateToControlUiSession(page, own.key);
        await historyText.waitFor();
        const unreadBadge = ownRow.locator(".sidebar-session-indicator .session-unread-dot");
        if (canOrganize) {
          await waitForPatch(
            gateway,
            (params) =>
              params.key === own.key &&
              params.unread === false &&
              typeof params.expectedMarkedUnreadAt === "number",
          );
          await unreadBadge.waitFor({ state: "hidden" });
        }
        expect(await composer.isEditable()).toBe(canOrganize);
        expect(await send.isDisabled()).toBe(true);
        expect(await model.getAttribute("aria-disabled")).toBe(String(!canOrganize));
        expect(await permission.isDisabled()).toBe(!canOrganize);
        if (!canOrganize) {
          await send.click({ force: true });
          await model.click({ force: true });
          await permission.click({ force: true });
          expect(await activePane.locator(".chat-controls__model-picker[open]").count()).toBe(0);
        }
        const sharing = button(activePane, "Session sharing");
        expect((await sharing.count()) > 0 && !(await sharing.isDisabled())).toBe(false);
        await ownRow.click({ button: "right" });
        await rename.waitFor();
        expect((await rename.getAttribute("disabled")) === null).toBe(canOrganize);
        expect((await archive.getAttribute("disabled")) === null).toBe(canOrganize);
        expect(await fork.getAttribute("disabled")).not.toBeNull();
        const unread = menu.locator('[data-value="toggle-unread"]');
        expect(await unread.isDisabled()).toBe(!canOrganize);
        if (canOrganize) {
          await unread.click();
          await unreadBadge.waitFor();
          await activePane.locator(".chat-header-session-menu__trigger").click();
          await menuItem(
            activePane.locator("openclaw-chat-header-session-menu"),
            "Mark as read",
          ).click();
          await activePane.locator(".chat-header-session-menu__panel").waitFor({ state: "hidden" });
          await unreadBadge.waitFor({ state: "hidden" });
          await ownRow.click({ button: "right" });
          await rename.waitFor();
        } else {
          await unread.click({ force: true });
        }
        const moveToGroup = menuItem(menu, "Move to group", false);
        expect(await moveToGroup.getAttribute("disabled")).not.toBeNull();
        await moveToGroup.click({ force: true });
        await openSessionMenuSubmenu(page, "Advanced");
        const appearance = menuItem(menu, "Icon & color");
        expect(await appearance.getAttribute("disabled")).not.toBeNull();
        await appearance.click({ force: true });
        await page.keyboard.press("ArrowLeft");
        if (canOrganize) {
          await rename.click();
          await submitInputDialog(page, "Organized workspace");
          await sessionPatch(gateway, own.key, { label: "Organized workspace" });
          await expect.poll(() => ownRow.textContent()).toContain("Organized workspace");
          await ownRow.hover();
          await button(ownRow, "Pin session").click();
          await button(ownRow, "Unpin session").waitFor();
          await ownRow.click({ button: "right" });
          await activateSelfRemovingControl(archive);
          await sessionPatch(gateway, own.key, { archived: true });
          await button(page, "Undo").waitFor();

          await page.evaluate((url) => {
            history.pushState(null, "", url);
            dispatchEvent(new PopStateEvent("popstate"));
          }, `${suite.server.baseUrl}sessions?status=archived`);
          await waitForControlUiRoute(page, { pathname: "/sessions", routeId: "sessions" });
          const archivedRow = page
            .locator(".session-data-row")
            .filter({ hasText: "Organized workspace" });
          await archivedRow.waitFor();
          await button(archivedRow, "Open session menu").click();
          await openSessionMenuSubmenu(page, "Advanced");
          const remove = menu.locator('[data-value="delete"]');
          await remove.waitFor();
          expect(await remove.getAttribute("disabled")).not.toBeNull();
          await remove.click({ force: true });

          await page.keyboard.press("ArrowLeft");
          await activateSelfRemovingControl(archive);
          await sessionPatch(gateway, own.key, { archived: false });
          await archivedRow.waitFor({ state: "detached" });
          await navigateToControlUiSession(page, own.key);
          await historyText.waitFor();
          await expect.poll(() => ownRow.textContent()).toContain("Organized workspace");
        } else {
          await rename.click({ force: true });
          await archive.click({ force: true });
          await page.keyboard.press("Escape");
          await ownRow.hover();
          const pin = button(ownRow, "Pin session");
          // Personal navigation remains available without shared-session mutation authority.
          expect(await pin.isDisabled()).toBe(false);
          await pin.click();
          await button(ownRow, "Unpin session").waitFor();
        }
        const pinRef = `session:${own.key}`;
        await expect
          .poll(() => page.locator(`.sidebar-rail [data-sidebar-entry="${pinRef}"]`).count())
          .toBe(1);
        await expect
          .poll(() =>
            page.evaluate(
              (key) =>
                JSON.parse(localStorage.getItem(key) ?? "{}").navigationByProfile?.["scope-reader"]
                  ?.railShortcuts,
              controlUiBundledSettingsStorageKey(suite.server.baseUrl),
            ),
          )
          .toContain(pinRef);
        const forbiddenMethods = new Set([
          "sessions.create",
          "sessions.dispatch",
          "sessions.delete",
          "session.visibility.set",
          "sessions.fork",
          "sessions.catalog.continue",
          "sessions.catalog.startTerminal",
          "sessions.groups.put",
          "sessions.assignOwner",
          // Narrow session scopes retain pins locally, without broader profile/config writes.
          "users.prefs.set",
          "config.patch",
        ]);
        const requests = await gateway.getRequests();
        if (!canOrganize) {
          expect(requests.filter((request) => request.method === "chat.send")).toEqual([]);
        }
        expect(requests.filter((request) => forbiddenMethods.has(request.method))).toEqual([]);
        const patches = requests
          .filter((request) => request.method === "sessions.patch")
          .map((request) => requireRecord(request.params));
        const envelopeKeys = new Set([
          "agentId",
          "expectedSessionId",
          "expectedLifecycleRevision",
          "expectedMarkedUnreadAt",
        ]);
        expect(
          patches.map((params) =>
            Object.fromEntries(Object.entries(params).filter(([key]) => !envelopeKeys.has(key))),
          ),
        ).toEqual(
          canOrganize
            ? [
                { key: own.key, label: "List workspace" },
                { key: own.key, unread: true },
                { key: own.key, unread: false },
                { key: own.key, unread: true },
                { key: own.key, unread: false },
                { key: own.key, label: "Organized workspace" },
                { key: own.key, archived: true },
                { key: own.key, archived: false },
              ]
            : [],
        );
      });
    },
  );

  it("lets write-scoped operators delete archived sessions with archivedOnly", async () => {
    return suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const { deleteAll, gateway } = await openArchivedPage(page, [
        "operator.read",
        "operator.write",
      ]);
      await expect.poll(() => deleteAll.isEnabled()).toBe(true);
      await deleteAll.click();
      await confirmDelete(page);

      await expect(gateway.waitForRequest("sessions.delete")).resolves.toMatchObject({
        params: {
          archivedOnly: true,
          deleteTranscript: true,
          key: archived.key,
        },
      });
    });
  });

  it("keeps archived deletion disabled for read-scoped operators", async () => {
    return suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const { deleteAll, gateway } = await openArchivedPage(page, ["operator.read"]);
      await expect.poll(() => deleteAll.isDisabled()).toBe(true);
      await deleteAll.click({ force: true });
      expect(await gateway.getRequests("sessions.delete")).toHaveLength(0);
    });
  });
});
