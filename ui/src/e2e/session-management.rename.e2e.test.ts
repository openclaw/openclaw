import { expect, it } from "vitest";
import {
  pauseVirtualClock,
  type MockGatewayRequest,
  type MockGatewayWindow,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  captureUiProof,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
  waitForPatch,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();
const renameKey = "agent:main:rename-me";

suite.define(() => {
  it.each([
    { width: 390, height: 844, mobile: true },
    { width: 1280, height: 900, mobile: false },
  ])(
    "renames from header Actions at $width px and discards Cancel drafts",
    async ({ mobile, ...viewport }) => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport },
        async ({ page }) => {
          const original = sessionRow("agent:main:header-rename", "Original name", 1);
          const gateway = await installMockGateway(page, {
            methodResponses: { "sessions.list": sessionsListResponse([original]) },
            sessionKey: original.key,
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, original.key));
          const header = page.locator(
            mobile
              ? ".chat-pane-cache__pane--active .agent-chat__header--mobile"
              : ".chat-pane-cache__pane--active .chat-pane__header",
          );
          const actions = header.locator(".chat-header-session-menu__trigger");
          const openRename = async () => {
            await actions.click();
            await page
              .getByRole("menuitem", { name: mobile ? "Rename" : "Rename…", exact: true })
              .click();
          };
          await openRename();
          const dialog = page.getByRole("dialog", { name: "Rename session", exact: true });
          const inline = header.locator(".chat-pane__session-title-input");
          await page
            .locator("openclaw-modal-dialog input, .chat-pane__session-title-input")
            .waitFor();
          expect(await dialog.isVisible()).toBe(mobile);
          const input = mobile ? dialog.getByRole("textbox", { name: "Rename session" }) : inline;
          await expect.poll(() => input.inputValue()).toBe("Original name");
          expect(await input.evaluate((element) => element === document.activeElement)).toBe(true);
          await input.fill("Discarded draft");
          if (mobile) {
            await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
          } else {
            await input.press("Escape");
          }
          await input.waitFor({ state: "detached" });
          expect(await gateway.getRequests("sessions.patch")).toEqual([]);
          await openRename();
          expect(await input.inputValue()).toBe("Original name");
          await input.fill("Renamed from Actions");
          if (mobile) {
            await dialog.getByRole("button", { name: "Save", exact: true }).click();
          } else {
            await input.press("Enter");
          }
          const patch = await waitForPatch(
            gateway,
            (params) => params.label === "Renamed from Actions",
          );
          expect(patch.params).toMatchObject({
            key: original.key,
            expectedSessionId: original.sessionId,
            label: "Renamed from Actions",
          });
          expect(await gateway.getRequests("sessions.patch")).toHaveLength(1);
          await input.waitFor({ state: "detached" });
          await expect
            .poll(() =>
              header
                .locator(mobile ? ".mobile-header__title-text" : ".chat-pane__session-title-text")
                .textContent(),
            )
            .toContain("Renamed from Actions");
        },
      );
    },
  );

  it.each([false, true])(
    "keeps a duplicate rename in the dialog (concurrent failure: %s)",
    (concurrent) =>
      suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const gateway = await installMockGateway(page, {
          deferredMethods: ["sessions.patch"],
          methodResponses: {
            "sessions.list": sessionsListResponse([
              sessionRow(renameKey, "Rename me", Date.now()),
              ...(concurrent
                ? [sessionRow("agent:main:archive-me", "Archive me", Date.now())]
                : []),
            ]),
          },
          sessionKey: renameKey,
        });

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, renameKey));
        const row = page.locator(`[data-session-key="${renameKey}"]`);
        await row.waitFor({ state: "visible", timeout: 10_000 });
        await row.hover();
        let pendingArchive: MockGatewayRequest | null = null;
        if (concurrent) {
          // Race a shared archive error against the dialog-owned rename error.
          const archiveRow = page.locator('[data-session-key="agent:main:archive-me"]');
          await archiveRow.hover();
          await archiveRow
            .getByRole("button", { name: "Archive session: Archive me", exact: true })
            .click();
          pendingArchive = await gateway.waitForRequest("sessions.patch", {
            match: { key: "agent:main:archive-me", archived: true },
          });
          await gateway.deferNext("sessions.patch");
        }
        await row.click({ button: "right" });
        await page.getByRole("menuitem", { name: "Rename…" }).click();
        const dialog = page.locator('openclaw-modal-dialog[label="Rename session"]');
        const field = dialog.getByRole("textbox", { name: "Rename session" });
        const save = dialog.getByRole("button", { name: "Save" });
        await field.fill("Rejected rename");
        await save.click();
        const rename = await gateway.waitForRequest("sessions.patch", {
          after: concurrent ? 1 : 0,
        });
        await pauseVirtualClock(page);
        if (pendingArchive) {
          await page.evaluate(
            ({ renameId, archiveId }) => {
              const mock = (window as MockGatewayWindow).openclawControlUiE2eGateway;
              if (!mock) {
                throw new Error("Mock Gateway is not installed");
              }
              const reject = (id: string, code: string, message: string) =>
                mock.deliverLatest({ type: "res", id, ok: false, error: { code, message } });
              reject(renameId, "INVALID_REQUEST", "label already in use: Rejected rename");
              reject(archiveId, "UNAVAILABLE", "archive rejected");
            },
            { renameId: rename.id, archiveId: pendingArchive.id },
          );
        } else {
          await gateway.rejectDeferred("sessions.patch", {
            code: "INVALID_REQUEST",
            message: "label already in use: Rejected rename",
          });
        }

        const toasts = page.locator(".app-toast-lane--top-right .app-toast");
        await expect
          .poll(() => dialog.locator(".callout[role=alert]").textContent())
          .toContain("A session with this name already exists.");
        if (concurrent) {
          await expect
            .poll(() => toasts.filter({ hasText: "archive rejected" }).textContent())
            .toContain("archive rejected");
        } else {
          await expect.poll(() => toasts.count()).toBe(0);
        }
        await expect.poll(() => field.inputValue()).toBe("Rejected rename");

        await gateway.deferNext("sessions.patch");
        await field.fill("Unavailable rename");
        await save.click();
        const retry = await gateway.waitForRequest("sessions.patch", { after: concurrent ? 2 : 1 });
        await gateway.deliverLatest({
          type: "res",
          id: retry.id,
          ok: false,
          error: { code: "UNAVAILABLE", message: "sidebar rename rejected" },
        });

        const error = toasts.filter({ hasText: "sidebar rename rejected" });
        await error.waitFor({ state: "visible" });
        await expect.poll(() => error.textContent()).toContain("sidebar rename rejected");
        await expect
          .poll(() => dialog.locator(".callout[role=alert]").textContent())
          .toContain("sidebar rename rejected");
        expect(await dialog.getByRole("textbox", { name: "Rename session" }).inputValue()).toBe(
          "Unavailable rename",
        );
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        await dialog.waitFor({ state: "detached" });
        await expect.poll(() => page.locator("[data-sidebar-session-error]").count()).toBe(0);
      }),
  );

  it.each(["menu", "current name", "unselected name"] as const)(
    "renames a sidebar session from %s",
    (surface) =>
      suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "sessions.list": sessionsListResponse([
              sessionRow(renameKey, "Original name", Date.now()),
              sessionRow("agent:main:starting-session", "Starting session", Date.now() - 1),
            ]),
            "sessions.patch": {},
          },
          sessionKey: renameKey,
        });

        await page.goto(
          controlUiSessionUrl(
            suite.server.baseUrl,
            surface === "unselected name" ? "agent:main:starting-session" : renameKey,
          ),
        );
        const row = page.locator(`[data-session-key="${renameKey}"]`);
        await row.waitFor({ state: "visible", timeout: 10_000 });
        await page.evaluate(() => document.fonts.ready);
        const rowBounds = await row.boundingBox();
        if (surface === "menu") {
          await row.hover();
          await row.click({ button: "right" });
          await page.getByRole("menuitem", { name: "Rename…" }).click();
        } else {
          const startingName = surface === "unselected name" ? "Starting session" : "Original name";
          await expect
            .poll(() =>
              page
                .locator(".chat-pane-cache__pane--active .chat-pane__session-title-text")
                .textContent(),
            )
            .toContain(startingName);
          // The first click may navigate, but must retain the name's second-click target.
          await row.locator(".sidebar-recent-session__name").dblclick();
        }

        const dialog = page.getByRole("dialog", { name: "Rename session", exact: true });
        const name =
          surface === "menu"
            ? dialog.getByRole("textbox", { name: "Rename session" })
            : row.getByRole("textbox", { name: "Session title" });
        await name.waitFor({ state: "visible" });
        await expect.poll(() => name.inputValue()).toBe("Original name");
        if (surface !== "menu") {
          expect(await row.boundingBox()).toEqual(rowBounds);
          expect(
            await name.evaluate((element: HTMLInputElement) => ({
              focused: element === document.activeElement,
              selection: [element.selectionStart, element.selectionEnd],
              insideLink: Boolean(element.closest("a")),
            })),
          ).toEqual({ focused: true, selection: [0, 13], insideLink: false });
        }
        if (surface !== "menu") {
          expect(
            await name.evaluate((element) =>
              element.dispatchEvent(
                new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
              ),
            ),
          ).toBe(true);
          await name.click({ button: "right" });
          expect(await dialog.count()).toBe(0);
          await name.fill("Discarded draft");
          await name.press("Escape");
          await name.waitFor({ state: "detached" });
          expect(await gateway.getRequests("sessions.patch")).toEqual([]);
          await row.locator(".sidebar-recent-session__name").dblclick();
          await expect.poll(() => name.inputValue()).toBe("Original name");
        }
        await name.fill("Renamed session");
        if (surface === "menu") {
          await dialog.getByRole("button", { name: "Save" }).click();
        } else if (surface === "unselected name") {
          await name.press("Tab");
        } else {
          await name.press("Enter");
        }

        const patch = await waitForPatch(
          gateway,
          (params) => params.key === renameKey && params.label === "Renamed session",
        );
        expect(patch.params).toMatchObject({
          key: renameKey,
          expectedSessionId: `session:${renameKey}`,
          label: "Renamed session",
        });
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(1);
        await expect
          .poll(() =>
            page
              .locator(".chat-pane-cache__pane--active .chat-pane__session-title-text")
              .textContent(),
          )
          .toContain("Renamed session");
        await expect.poll(() => row.textContent()).toContain("Renamed session");
      }),
  );

  it("retains a rejected inline draft and allows correction without a duplicate write", () =>
    suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const original = sessionRow(renameKey, "Original name", 1);
      const gateway = await installMockGateway(page, {
        sessionKey: renameKey,
        sessions: [original],
        deferredMethods: ["sessions.patch"],
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, renameKey));
      const row = page.locator(`[data-session-key="${renameKey}"]`);
      await row.locator(".sidebar-recent-session__name").dblclick();
      const input = row.locator("input");
      await input.fill("Planning");
      await input.press("Enter");
      const rejected = await waitForPatch(gateway, (params) => params.label === "Planning");
      expect(rejected.params).toMatchObject({
        key: renameKey,
        expectedSessionId: original.sessionId,
      });
      await expect.poll(() => input.isEditable()).toBe(false);
      await input.press("Enter");
      await input.press("Tab");
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(1);
      await gateway.rejectDeferred("sessions.patch", {
        code: "INVALID_REQUEST",
        message: "label already in use: Planning",
      });
      await expect.poll(() => page.getByText(/label already in use/).count()).toBeGreaterThan(0);
      await expect.poll(() => input.isEditable()).toBe(true);
      expect(await input.inputValue()).toBe("Planning");
      await captureUiProof(suite, page, "sidebar-inline-rejected.png");
      await input.fill("Recovered name");
      await input.press("Enter");
      await waitForPatch(gateway, (params) => params.label === "Recovered name");
      await input.waitFor({ state: "detached" });
      await expect.poll(() => row.textContent()).toContain("Recovered name");
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(2);
    }));

  it.each(["scope", "ownership"] as const)("retires an inline draft after losing %s", (cause) =>
    suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        sessionKey: renameKey,
        operatorScopes: ["operator.sessions.read", "operator.sessions.write"],
        sessions: [sessionRow(renameKey, "Original name", 1, { sharingRole: "owner" })],
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, renameKey));
      const row = page.locator(`[data-session-key="${renameKey}"]`);
      await row.locator(".sidebar-recent-session__name").dblclick();
      const input = row.locator("input");
      await input.fill("Unsent draft");
      if (cause === "scope") {
        const connects = (await gateway.getRequests("connect")).length;
        await gateway.setOperatorScopes(["operator.sessions.read"]);
        await gateway.closeLatest(1001, "session permission changed");
        await gateway.waitForRequest("connect", { after: connects });
      } else {
        await gateway.emitGatewayEvent("sessions.changed", {
          ...sessionRow(renameKey, "Original name", 2, {
            sharingRole: "viewer",
            visibility: "read-only",
          }),
          sessionKey: renameKey,
          reason: "update",
        });
      }
      await input.waitFor({ state: "detached" });
      await expect.poll(() => row.locator("a[href]").count()).toBe(1);
      expect(await row.textContent()).toContain("Original name");
      expect(await gateway.getRequests("sessions.patch")).toEqual([]);
    }),
  );

  it("keeps navigation and modifier links without enabling read-only rename", () =>
    suite.withPage(createControlUiE2eContextOptions(), async ({ page, context }) => {
      const current = sessionRow("agent:main:current", "Current notes", 2);
      const viewer = sessionRow("agent:main:viewer", "Shared reference", 1, {
        sharingRole: "viewer",
        visibility: "read-only",
      });
      const gateway = await installMockGateway(page, {
        operatorScopes: ["operator.sessions.read"],
        sessionKey: current.key,
        sessions: [current, viewer],
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, current.key));
      const name = page.locator(`[data-session-key="${viewer.key}"] .sidebar-recent-session__name`);
      await name.click();
      const title = page.locator(".chat-pane-cache__pane--active .chat-pane__session-title-text");
      await expect.poll(() => title.textContent()).toContain("Shared reference");
      expect(await page.getByRole("dialog", { name: "Rename session", exact: true }).count()).toBe(
        0,
      );
      await name.dblclick();
      expect(await page.getByRole("dialog", { name: "Rename session", exact: true }).count()).toBe(
        0,
      );
      await expect.poll(() => name.locator("xpath=ancestor::a").count()).toBe(1);
      expect(await page.locator(".sidebar-recent-session input").count()).toBe(0);
      const opened = context.waitForEvent("page");
      await name.click({ modifiers: ["Control"] });
      const linked = await opened;
      await linked.waitForURL(/viewer/);
      await expect.poll(() => title.textContent()).toContain("Shared reference");
      await linked.close();
      expect(await gateway.getRequests("sessions.patch")).toEqual([]);
    }));
});
