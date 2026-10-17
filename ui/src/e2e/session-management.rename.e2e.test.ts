import path from "node:path";
import { expect, it } from "vitest";
import type { MockGatewayRequest, MockGatewayWindow } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  captureUiProof,
  captureUiProofEnabled,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
  waitForPatch,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it.each([false, true])(
    "keeps rejected renames retryable in the dialog (concurrent failure: %s)",
    async (concurrent) => {
      const context = await suite.browser.newContext(createControlUiE2eContextOptions());
      const page = await context.newPage();
      const gateway = await installMockGateway(page, {
        deferredMethods: ["sessions.patch"],
        methodResponses: {
          "sessions.list": sessionsListResponse([
            sessionRow("agent:main:rename-me", "Rename me", Date.now()),
            ...(concurrent ? [sessionRow("agent:main:archive-me", "Archive me", Date.now())] : []),
          ]),
        },
        sessionKey: "agent:main:rename-me",
      });

      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:rename-me"));
        const row = page.locator('[data-session-key="agent:main:rename-me"]');
        await row.waitFor({ state: "visible", timeout: 10_000 });
        await row.hover();
        let pendingArchive: MockGatewayRequest | null = null;
        if (concurrent) {
          // Personal pins no longer publish shared-session errors. Keep an independent
          // shared mutation in flight to prove duplicate-rename errors stay in the dialog.
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
        await dialog.getByRole("textbox", { name: "Rename session" }).fill("Rejected rename");
        await dialog.getByRole("button", { name: "Save" }).click();
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
              mock.deliverLatest({
                type: "res",
                id: renameId,
                ok: false,
                error: {
                  code: "INVALID_REQUEST",
                  message: "label already in use: Rejected rename",
                },
              });
              mock.deliverLatest({
                type: "res",
                id: archiveId,
                ok: false,
                error: {
                  code: "UNAVAILABLE",
                  message: "archive rejected",
                },
              });
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
        await expect
          .poll(() => dialog.getByRole("textbox", { name: "Rename session" }).inputValue())
          .toBe("Rejected rename");
        await captureUiProof(
          suite,
          page,
          concurrent
            ? "sidebar-session-duplicate-rename-concurrent.png"
            : "sidebar-session-duplicate-rename.png",
          dialog.locator("dialog"),
          [dialog.getByRole("alert")],
        );

        await gateway.deferNext("sessions.patch");
        await dialog.getByRole("textbox", { name: "Rename session" }).fill("Unavailable rename");
        await dialog.getByRole("button", { name: "Save" }).click();
        await gateway.waitForRequest("sessions.patch", {
          after: concurrent ? 2 : 1,
        });
        const retryMatch = { key: "agent:main:rename-me", label: "Unavailable rename" };
        await gateway.rejectDeferred(
          "sessions.patch",
          { code: "UNAVAILABLE", message: "sidebar rename rejected" },
          { match: retryMatch },
        );

        await error.waitFor({ state: "visible" });
        await expect.poll(() => error.textContent()).toContain("sidebar rename rejected");
        expect(
          await error
            .locator("xpath=ancestor::*[contains(@class, 'sidebar-recent-sessions')]")
            .count(),
        ).toBe(0);

        await captureUiProof(
          suite,
          page,
          concurrent
            ? "sidebar-rename-unavailable-concurrent.png"
            : "sidebar-rename-unavailable.png",
        );
        expect(await dialog.count()).toBe(1);
        await expect
          .poll(() => dialog.getByRole("alert").textContent())
          .toContain("sidebar rename rejected");
        expect(await dialog.getByRole("textbox", { name: "Rename session" }).inputValue()).toBe(
          "Unavailable rename",
        );
        expect(await dialog.getByRole("button", { name: "Save" }).isEnabled()).toBe(true);

        await gateway.deferNext("sessions.patch");
        await dialog.getByRole("button", { name: "Save" }).click();
        const recovered = await gateway.waitForRequest("sessions.patch", {
          after: concurrent ? 3 : 2,
        });
        expect(recovered.params).toMatchObject(retryMatch);
        await gateway.resolveDeferred("sessions.patch", {}, { match: retryMatch });
        await dialog.waitFor({ state: "detached" });
        await expect.poll(() => row.textContent()).toContain("Unavailable rename");

        await error.getByRole("button", { name: "Dismiss error" }).click();
        await expect.poll(() => error.count()).toBe(0);
      } finally {
        await context.close();
      }
    },
  );

  it("renames a sidebar session through an in-app dialog", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      recordVideo: captureUiProofEnabled
        ? { dir: suite.artifactDir, size: { height: 900, width: 1280 } }
        : undefined,
    });
    const page = await context.newPage();
    const proofVideo = page.video();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:rename-me", "Original name", Date.now()),
        ]),
        "sessions.patch": {},
      },
      sessionKey: "agent:main:rename-me",
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:rename-me"));
      const row = page.locator('[data-session-key="agent:main:rename-me"]');
      await row.waitFor({ state: "visible", timeout: 10_000 });
      await row.hover();
      await row.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Rename…" }).click();

      await page.getByRole("dialog", { name: "Rename session" }).waitFor({ state: "visible" });
      const dialog = page.locator('openclaw-modal-dialog[label="Rename session"]');
      const name = dialog.getByRole("textbox", { name: "Rename session" });
      await name.waitFor({ state: "visible" });
      await expect.poll(() => name.inputValue()).toBe("Original name");
      await captureUiProof(
        suite,
        page,
        "sidebar-session-rename-dialog.png",
        dialog.locator("dialog"),
        [name],
      );
      await name.fill("Renamed session");
      await dialog.getByRole("button", { name: "Save" }).click();

      const patch = await waitForPatch(
        gateway,
        (params) => params.key === "agent:main:rename-me" && params.label === "Renamed session",
      );
      expect(patch.params).toMatchObject({
        key: "agent:main:rename-me",
        label: "Renamed session",
      });
      await expect.poll(() => row.textContent()).toContain("Renamed session");
      await captureUiProof(suite, page, "sidebar-session-renamed.png");
    } finally {
      await context.close();
      if (proofVideo) {
        await proofVideo.saveAs(path.join(suite.artifactDir, "sidebar-session-rename.webm"));
      }
    }
  });
});
