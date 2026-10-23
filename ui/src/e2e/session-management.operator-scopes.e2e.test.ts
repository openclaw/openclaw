import { it, expect } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  navigateToControlUiSession,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import * as ui from "./session-management.compact.test-support.ts";
import * as support from "./session-management.test-support.ts";

const suite = support.createSessionManagementE2eSuite();

const archived = sessionRow(
  "agent:main:archived-write-scope",
  "Archived write scope",
  Date.parse("2026-08-01T12:00:00.000Z"),
  { archived: true },
);

async function openArchivedPage(page: import("playwright").Page, operatorScopes: string[]) {
  const gateway = await ui.installSessionRows(page, [archived], {
    featureMethods: ["chat.metadata", "chat.startup", "sessions.delete"],
    operatorScopes,
    sessionArchiveFiltering: true,
    methodResponses: { "sessions.delete": { deleted: true } },
  });
  await page.goto(`${suite.server.baseUrl}sessions?status=archived`);
  await ui.button(page, "Filters", false).click();
  const deleteAll = ui.button(page, /Delete all archived/, false);
  await deleteAll.waitFor();
  return { deleteAll, gateway };
}

suite.define(() => {
  it.each([
    { scope: "operator.sessions.read", name: "SESSION_READ", canOrganize: false },
    { scope: "operator.sessions.write", name: "SESSION_WRITE", canOrganize: true },
  ])(
    "$name reads shared history and limits organization to existing owned sessions",
    ({ scope, canOrganize }) =>
      suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const timestamp = Date.parse("2026-09-20T12:00:00.000Z");
        const shared = sessionRow("agent:main:shared-notes", "Shared notes", timestamp, {
          sharingRole: "member",
          visibility: "shared",
        });
        const own = sessionRow("agent:main:my-notes", "My workspace", timestamp - 60_000, {
          sharingRole: "owner",
          visibility: "shared",
        });
        const gateway = await support.installMockGateway(page, {
          operatorScopes: [scope],
          sessionKey: shared.key,
          sessions: [shared, own],
          sessionArchiveFiltering: true,
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
        const rowFor = ui.sessionRows(page);
        const ownRow = rowFor(own.key);
        const navigate = async (key: string) => {
          await navigateToControlUiSession(page, key);
          await historyText.waitFor();
        };
        const expectChatAuthority = async (editable: boolean) => {
          expect(await composer.isEditable()).toBe(editable);
          expect(await send.isDisabled()).toBe(true);
          expect(await model.getAttribute("aria-disabled")).toBe(String(!editable));
          expect(await permission.isDisabled()).toBe(!editable);
        };
        const openOwnMenu = async () => {
          await ownRow.click({ button: "right" });
          await rename.waitFor();
        };
        const listRow = (label: string) =>
          page.locator(".session-data-row").filter({ hasText: label });
        const showSessions = async (suffix = "") => {
          await page.evaluate((url) => {
            history.pushState(null, "", url);
            dispatchEvent(new PopStateEvent("popstate"));
          }, `${suite.server.baseUrl}sessions${suffix}`);
          await waitForControlUiRoute(page, { pathname: "/sessions", routeId: "sessions" });
        };
        const forceDisabled = async (control: import("playwright").Locator) => {
          expect(await control.getAttribute("disabled")).not.toBeNull();
          await control.click({ force: true });
        };
        const showDetails = async (label: string) => {
          await listRow(label).locator(".session-details-toggle").click();
          await detailsLabel.waitFor();
        };
        await page.goto(support.controlUiSessionUrl(suite.server.baseUrl, own.key));
        await historyText.waitFor();
        await openOwnMenu();

        await page.keyboard.press("Escape");
        await navigate(shared.key);

        await showSessions();
        const detailsLabel = page.locator(".session-details-row").getByRole("textbox", {
          name: "Label",
          exact: true,
        });
        await showDetails("Shared notes");
        expect(await detailsLabel.isDisabled()).toBe(true);
        await showDetails("My workspace");

        expect(await detailsLabel.isEditable()).toBe(canOrganize);
        if (canOrganize) {
          await detailsLabel.fill("List workspace");
          await detailsLabel.press("Tab");
          await ui.sessionPatch(gateway, own.key, { label: "List workspace" });
          await ui.button(listRow("List workspace"), "Open session menu", false).click();
          await ui.menuItem(menu, "Mark as unread").click();
          await ui.sessionPatch(gateway, own.key, { unread: true });
        }
        await navigate(shared.key);
        await expectChatAuthority(false);
        const create = page.locator(".sidebar-rail .sidebar-new-session");
        expect(await create.isDisabled()).toBe(!canOrganize);
        if (!canOrganize) {
          await create.click({ force: true });
          expect(new URL(page.url()).pathname).not.toBe("/new");
        }
        await rowFor(shared.key).click({ button: "right" });
        await rename.waitFor();
        for (const control of [rename, archive, fork]) {
          expect(await control.getAttribute("disabled")).not.toBeNull();
        }
        expect(await menu.locator('[data-value="toggle-unread"]').isDisabled()).toBe(true);
        await rename.click({ force: true });
        await archive.click({ force: true });
        await page.keyboard.press("Escape");

        await navigate(own.key);
        const unreadBadge = ownRow.locator(".sidebar-session-indicator .session-unread-dot");
        if (canOrganize) {
          const request = await ui.sessionPatch(gateway, own.key, { unread: false });
          expect(request.params).toHaveProperty("expectedMarkedUnreadAt", expect.any(Number));
          await unreadBadge.waitFor({ state: "hidden" });
        }
        await expectChatAuthority(canOrganize);
        if (!canOrganize) {
          await send.click({ force: true });
          await model.click({ force: true });
          await permission.click({ force: true });
          expect(await activePane.locator(".chat-controls__model-picker[open]").count()).toBe(0);
        }
        const sharing = ui.button(activePane, "Session sharing");
        expect((await sharing.count()) > 0 && !(await sharing.isDisabled())).toBe(false);
        await openOwnMenu();
        for (const control of [rename, archive]) {
          expect((await control.getAttribute("disabled")) === null).toBe(canOrganize);
        }
        expect(await fork.getAttribute("disabled")).not.toBeNull();
        const unread = menu.locator('[data-value="toggle-unread"]');
        expect(await unread.isDisabled()).toBe(!canOrganize);
        if (canOrganize) {
          await unread.click();
          await unreadBadge.waitFor();
          await activePane.locator(".chat-header-session-menu__trigger").click();
          await ui
            .menuItem(activePane.locator("openclaw-chat-header-session-menu"), "Mark as read")
            .click();
          await activePane.locator(".chat-header-session-menu__panel").waitFor({ state: "hidden" });
          await unreadBadge.waitFor({ state: "hidden" });
          await openOwnMenu();
        } else {
          await unread.click({ force: true });
        }
        await forceDisabled(ui.menuItem(menu, "Move to group", false));
        await support.openSessionMenuSubmenu(page, "Advanced");
        await forceDisabled(ui.menuItem(menu, "Icon & color"));
        await page.keyboard.press("ArrowLeft");
        if (canOrganize) {
          await rename.click();
          await support.submitInputDialog(page, "Organized workspace");
          await ui.sessionPatch(gateway, own.key, { label: "Organized workspace" });
          await ui.expectText(ownRow, "Organized workspace");
          await ownRow.hover();
          await ui.button(ownRow, "Pin session").click();
          await ui.button(ownRow, "Unpin session").waitFor();
          await ownRow.click({ button: "right" });
          await support.activateSelfRemovingControl(archive);
          await ui.sessionPatch(gateway, own.key, { archived: true });
          await ui.button(page, "Undo").waitFor();

          await showSessions("?status=archived");
          const archivedRow = listRow("Organized workspace");
          await archivedRow.waitFor();
          await ui.button(archivedRow, "Open session menu", false).click();
          await support.openSessionMenuSubmenu(page, "Advanced");
          const remove = menu.locator('[data-value="delete"]');
          await remove.waitFor();
          await forceDisabled(remove);

          await page.keyboard.press("ArrowLeft");
          await support.activateSelfRemovingControl(archive);
          await ui.sessionPatch(gateway, own.key, { archived: false });
          await archivedRow.waitFor({ state: "detached" });
          await navigate(own.key);
          await ui.expectText(ownRow, "Organized workspace");
        } else {
          await rename.click({ force: true });
          await archive.click({ force: true });
          await page.keyboard.press("Escape");
          await ownRow.hover();
          const pin = ui.button(ownRow, "Pin session");
          // Personal navigation remains available without shared-session mutation authority.
          expect(await pin.isDisabled()).toBe(false);
          await pin.click();
          await ui.button(ownRow, "Unpin session").waitFor();
        }
        const pinRef = `session:${own.key}`;
        await ui.expectCount(
          page.locator(`[data-session-section="pinned"] [data-session-key="${own.key}"]`),
          1,
        );
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
        await ui.expectNoRequests(
          gateway,
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
          ...(!canOrganize ? ["chat.send"] : []),
        );
        const patches = (await gateway.getRequests("sessions.patch")).map((request) =>
          support.requireRecord(request.params),
        );
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
      }),
  );

  it.each([false, true])("gates archived deletion by write scope (write=%s)", (canDelete) =>
    suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const { deleteAll, gateway } = await openArchivedPage(page, [
        "operator.read",
        ...(canDelete ? ["operator.write"] : []),
      ]);
      if (canDelete) {
        await expect.poll(() => deleteAll.isEnabled()).toBe(true);
        await deleteAll.click();
        await ui.button(page.locator("openclaw-modal-dialog").last(), "Delete").click();
        await expect(gateway.waitForRequest("sessions.delete")).resolves.toMatchObject({
          params: { archivedOnly: true, deleteTranscript: true, key: archived.key },
        });
      } else {
        await expect.poll(() => deleteAll.isDisabled()).toBe(true);
        await deleteAll.click({ force: true });
        expect(await gateway.getRequests("sessions.delete")).toHaveLength(0);
      }
    }),
  );
});
