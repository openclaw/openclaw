import { expect, it } from "vitest";
import type { MockGatewayRequest, MockGatewayWindow } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
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

        const error = page.locator("[data-sidebar-session-error]");
        await expect
          .poll(() => dialog.getByRole("alert").textContent())
          .toContain("A session with this name already exists.");
        if (concurrent) {
          await expect.poll(() => error.textContent()).toContain("archive rejected");
        } else {
          await expect.poll(() => error.count()).toBe(0);
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

        await error.waitFor({ state: "visible" });
        await expect.poll(() => error.textContent()).toContain("sidebar rename rejected");
        expect(
          await error
            .locator("xpath=ancestor::*[contains(@class, 'sidebar-recent-sessions')]")
            .count(),
        ).toBe(0);

        await expect
          .poll(() => dialog.getByRole("alert").textContent())
          .toContain("sidebar rename rejected");
        expect(await dialog.getByRole("textbox", { name: "Rename session" }).inputValue()).toBe(
          "Unavailable rename",
        );
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        await dialog.waitFor({ state: "detached" });
        await error.getByRole("button", { name: "Dismiss error" }).click();
        await expect.poll(() => error.count()).toBe(0);
      }),
  );

  it("renames a sidebar session through an in-app dialog", () =>
    suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "sessions.list": sessionsListResponse([
            sessionRow(renameKey, "Original name", Date.now()),
          ]),
          "sessions.patch": {},
        },
        sessionKey: renameKey,
      });

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, renameKey));
      const row = page.locator(`[data-session-key="${renameKey}"]`);
      await row.waitFor({ state: "visible", timeout: 10_000 });
      await row.hover();
      await row.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Rename…" }).click();

      await page.getByRole("dialog", { name: "Rename session" }).waitFor({ state: "visible" });
      const dialog = page.locator('openclaw-modal-dialog[label="Rename session"]');
      const name = dialog.getByRole("textbox", { name: "Rename session" });
      await name.waitFor({ state: "visible" });
      await expect.poll(() => name.inputValue()).toBe("Original name");
      await name.fill("Renamed session");
      await dialog.getByRole("button", { name: "Save" }).click();

      const patch = await waitForPatch(
        gateway,
        (params) => params.key === renameKey && params.label === "Renamed session",
      );
      expect(patch.params).toMatchObject({ key: renameKey, label: "Renamed session" });
      await expect.poll(() => row.textContent()).toContain("Renamed session");
    }));
});
