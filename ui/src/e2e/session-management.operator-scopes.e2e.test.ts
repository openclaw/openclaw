import path from "node:path";
import { expect, it } from "vitest";
import {
  captureControlUiE2eFailureDiagnostics,
  navigateToControlUiSession,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  activateSelfRemovingControl,
  captureUiProof,
  captureUiProofEnabled,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
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
  await page
    .locator("openclaw-modal-dialog")
    .last()
    .getByRole("button", { name: "Delete", exact: true })
    .click();
}

async function openArchivedPage(operatorScopes: string[]) {
  const context = await suite.browser.newContext(createControlUiE2eContextOptions());
  const page = await context.newPage();
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
  const deleteAll = page.getByRole("button", { name: /Delete all archived/ });
  await deleteAll.waitFor();
  return { context, deleteAll, gateway, page };
}

suite.define(() => {
  it.each([
    { scope: "operator.sessions.read", name: "SESSION_READ", canOrganize: false },
    { scope: "operator.sessions.write", name: "SESSION_WRITE", canOrganize: true },
  ])(
    "$name reads shared history and limits organization to existing owned sessions",
    async ({ scope, name, canOrganize }) => {
      const viewport = { width: 1280, height: 900 };
      const context = await suite.browser.newContext({
        ...createControlUiE2eContextOptions(),
        viewport,
        ...(captureUiProofEnabled
          ? { recordVideo: { dir: suite.artifactDir, size: viewport } }
          : {}),
      });
      const page = await context.newPage();
      const video = page.video();
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
      try {
        const activePane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
        const historyText = activePane
          .getByRole("paragraph")
          .filter({ hasText: /^Recorded project notes remain readable\.$/u });
        const composer = activePane.locator(".agent-chat__composer-combobox > textarea");
        const send = activePane.locator("button.chat-send-btn--send");
        const model = activePane.locator("[data-chat-model-select]");
        const permission = activePane.locator("[data-chat-permission-select]");
        const menu = page.locator("openclaw-session-menu");
        const rename = menu.locator('wa-dropdown-item[value="rename"]');
        const archive = menu.locator('wa-dropdown-item[value="toggle-archived"]');
        const fork = menu.locator('wa-dropdown-item[value="fork"]');
        const ownRow = page.locator(`.sidebar-recent-session[data-session-key="${own.key}"]`);
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, own.key));
        await historyText.waitFor();
        await ownRow.click({ button: "right" });
        await rename.waitFor();
        await captureUiProof(suite, page, `${name}-owned-menu.png`, menu.locator('[part="menu"]'), [
          rename,
          archive,
        ]);
        await page.keyboard.press("Escape");
        await navigateToControlUiSession(page, shared.key);
        await historyText.waitFor();
        await captureUiProof(suite, page, `${name}-shared-history.png`, activePane, [
          historyText,
          composer,
        ]);
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
        await captureUiProof(suite, page, `${name}-owned-details.png`, detailsLabel);
        expect(await detailsLabel.isEditable()).toBe(canOrganize);
        if (canOrganize) {
          await detailsLabel.fill("List workspace");
          await detailsLabel.press("Tab");
          await waitForPatch(
            gateway,
            (params) => params.key === own.key && params.label === "List workspace",
          );
        }
        await navigateToControlUiSession(page, shared.key);
        await historyText.waitFor();
        expect(await composer.isEditable()).toBe(false);
        expect(await send.isDisabled()).toBe(true);
        expect(await model.getAttribute("aria-disabled")).toBe("true");
        expect(await permission.isDisabled()).toBe(true);
        const create = page.locator(".sidebar-brand__new-thread");
        expect(await create.isDisabled()).toBe(true);
        await create.click({ force: true });
        expect(new URL(page.url()).pathname).not.toBe("/new");
        const sharedRow = page.locator(`.sidebar-recent-session[data-session-key="${shared.key}"]`);
        await sharedRow.click({ button: "right" });
        await rename.waitFor();
        expect(await rename.getAttribute("disabled")).not.toBeNull();
        expect(await archive.getAttribute("disabled")).not.toBeNull();
        expect(await fork.getAttribute("disabled")).not.toBeNull();
        await rename.click({ force: true });
        await archive.click({ force: true });
        await page.keyboard.press("Escape");

        await navigateToControlUiSession(page, own.key);
        await historyText.waitFor();
        expect(await composer.isEditable()).toBe(canOrganize);
        expect(await send.isDisabled()).toBe(true);
        expect(await model.getAttribute("aria-disabled")).toBe("true");
        expect(await permission.isDisabled()).toBe(true);
        if (!canOrganize) {
          await send.click({ force: true });
        }
        await model.click({ force: true });
        await permission.click({ force: true });
        expect(await activePane.locator(".chat-controls__model-picker[open]").count()).toBe(0);
        const sharing = activePane.getByRole("button", { name: "Session sharing", exact: true });
        expect((await sharing.count()) > 0 && !(await sharing.isDisabled())).toBe(false);
        await ownRow.click({ button: "right" });
        await rename.waitFor();
        expect((await rename.getAttribute("disabled")) === null).toBe(canOrganize);
        expect((await archive.getAttribute("disabled")) === null).toBe(canOrganize);
        expect(await fork.getAttribute("disabled")).not.toBeNull();
        for (const action of [
          menu.getByRole("menuitem", { name: "Icon & color" }),
          menu.locator('wa-dropdown-item[value="toggle-unread"]'),
          menu.getByRole("menuitem", { name: "Move to group" }),
        ]) {
          expect(await action.getAttribute("disabled")).not.toBeNull();
          await action.click({ force: true });
        }
        if (canOrganize) {
          await rename.click();
          await submitInputDialog(page, "Organized workspace");
          await waitForPatch(
            gateway,
            (params) => params.key === own.key && params.label === "Organized workspace",
          );
          await expect.poll(() => ownRow.textContent()).toContain("Organized workspace");
          await ownRow.hover();
          await ownRow.getByRole("button", { name: "Pin session", exact: true }).click();
          await waitForPatch(gateway, (params) => params.key === own.key && params.pinned === true);
          await ownRow.click({ button: "right" });
          await activateSelfRemovingControl(archive);
          await waitForPatch(
            gateway,
            (params) => params.key === own.key && params.archived === true,
          );
          await page.getByRole("button", { name: "Undo", exact: true }).waitFor();
          await captureUiProof(suite, page, `${name}-owned-archived.png`);
          await page.evaluate((url) => {
            history.pushState(null, "", url);
            dispatchEvent(new PopStateEvent("popstate"));
          }, `${suite.server.baseUrl}sessions?status=archived`);
          await waitForControlUiRoute(page, { pathname: "/sessions", routeId: "sessions" });
          const archivedRow = page
            .locator(".session-data-row")
            .filter({ hasText: "Organized workspace" });
          await archivedRow.waitFor();
          await archivedRow.getByRole("button", { name: "Open session menu", exact: true }).click();
          const remove = menu.locator('wa-dropdown-item[value="delete"]');
          await remove.waitFor();
          expect(await remove.getAttribute("disabled")).not.toBeNull();
          await remove.click({ force: true });
          await captureUiProof(
            suite,
            page,
            `${name}-archived-controls.png`,
            menu.locator('[part="menu"]'),
            [remove, archive],
          );
          await activateSelfRemovingControl(archive);
          await waitForPatch(
            gateway,
            (params) => params.key === own.key && params.archived === false,
          );
          await archivedRow.waitFor({ state: "detached" });
          await navigateToControlUiSession(page, own.key);
          await historyText.waitFor();
          await expect.poll(() => ownRow.textContent()).toContain("Organized workspace");
          await captureUiProof(suite, page, `${name}-owned-restored.png`, activePane, [
            historyText,
          ]);
        } else {
          await rename.click({ force: true });
          await archive.click({ force: true });
          await page.keyboard.press("Escape");
          await ownRow.hover();
          const pin = ownRow.getByRole("button", { name: "Pin session", exact: true });
          expect(await pin.isDisabled()).toBe(true);
          await pin.click({ force: true });
        }
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
        ]);
        const requests = await gateway.getRequests();
        if (!canOrganize) {
          expect(requests.filter((request) => request.method === "chat.send")).toEqual([]);
        }
        expect(requests.filter((request) => forbiddenMethods.has(request.method))).toEqual([]);
        const patches = requests
          .filter((request) => request.method === "sessions.patch")
          .map((request) => requireRecord(request.params));
        const envelopeKeys = new Set(["agentId", "expectedSessionId", "expectedLifecycleRevision"]);
        expect(
          patches.map((params) =>
            Object.fromEntries(Object.entries(params).filter(([key]) => !envelopeKeys.has(key))),
          ),
        ).toEqual(
          canOrganize
            ? [
                { key: own.key, label: "List workspace" },
                { key: own.key, label: "Organized workspace" },
                { key: own.key, pinned: true },
                { key: own.key, archived: true },
                { key: own.key, archived: false },
              ]
            : [],
        );
      } catch (error) {
        await captureControlUiE2eFailureDiagnostics(page, {
          error: error instanceof Error ? error : new Error(String(error)),
          label: `session-read-organization-${name}`,
        });
        throw error;
      } finally {
        await context.close();
        if (video) {
          await video.saveAs(path.join(suite.artifactDir, `${name}-read-organization.webm`));
        }
      }
    },
  );

  it("lets write-scoped operators delete archived sessions with archivedOnly", async () => {
    const { context, deleteAll, gateway, page } = await openArchivedPage([
      "operator.read",
      "operator.write",
    ]);
    try {
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
    } finally {
      await context.close();
    }
  });

  it("keeps archived deletion disabled for read-scoped operators", async () => {
    const { context, deleteAll, gateway } = await openArchivedPage(["operator.read"]);
    try {
      await expect.poll(() => deleteAll.isDisabled()).toBe(true);
      await deleteAll.click({ force: true });
      expect(await gateway.getRequests("sessions.delete")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });
});
