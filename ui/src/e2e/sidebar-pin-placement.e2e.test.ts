import { expect, it } from "vitest";
import {
  CHAT_SNAPSHOT_DB_NAME,
  SIDEBAR_SNAPSHOT_STORE_NAME,
} from "../pages/chat/session-snapshot-database.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  createSessionManagementE2eSuite,
  controlUiSessionUrl,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";
import { captureFrame } from "./sidebar-assertions.test-support.ts";

const suite = createSessionManagementE2eSuite(true);
const key = "agent:main:reliability";

suite.define(() => {
  it("keeps button pins in the sidebar and independently adds and removes rail shortcuts", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        sessionKey: key,
        methodResponses: {
          "sessions.list": sessionsListResponse([
            createControlUiSessionRow(key, "Reliability Tracker", Date.now(), { icon: "🛠️" }),
            createControlUiSessionRow(
              "agent:main:release",
              "Release checklist",
              Date.now() - 1000,
              { icon: "🚀" },
            ),
          ]),
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
      const sidebar = page.locator("openclaw-app-sidebar");
      const row = sidebar.locator(`.sidebar-recent-session[data-session-key="${key}"]`);
      await row.waitFor();
      await row.hover();
      await row.getByRole("button", { name: "Pin session", exact: true }).click();
      await row.getByRole("button", { name: "Unpin session", exact: true }).waitFor();
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        const dir = createControlUiE2eArtifactDir(
          "pin-placement",
          process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR,
        );
        await captureFrame(
          dir,
          process.env.OPENCLAW_PIN_PROOF_STAGE + ".png",
          page.locator(".shell"),
          [row, sidebar.locator(".sidebar-rail")],
        );
        console.log("Pin placement proof: " + dir);
      }
      const pinned = sidebar.locator('[data-session-section="pinned"]');
      await expect
        .poll(() => pinned.locator(`.sidebar-recent-session[data-session-key="${key}"]`).count())
        .toBe(1);
      const rail = sidebar.locator(".sidebar-rail__pins");
      expect(await rail.locator(".sidebar-rail__pin").count()).toBe(0);
      await row.locator("a.sidebar-recent-session__link").click({ modifiers: ["Alt"] });
      await pinned.locator(".sidebar-session-group-toggle").click();
      const plain = sidebar.locator(
        '.sidebar-recent-session[data-session-key="agent:main:release"]',
      );
      await plain.locator("a.sidebar-recent-session__link").click({ modifiers: ["Shift"] });
      await pinned.locator(".sidebar-session-group-toggle").click();
      expect(
        await row.evaluate((element) =>
          element.classList.contains("sidebar-recent-session--selected"),
        ),
      ).toBe(false);
      expect(
        await plain.evaluate((element) =>
          element.classList.contains("sidebar-recent-session--selected"),
        ),
      ).toBe(true);
      await plain.locator("a.sidebar-recent-session__link").click();
      await row.dragTo(rail);
      const shortcut = rail.locator('[data-sidebar-entry="session-rail:' + key + '"]');
      await shortcut.waitFor();
      await pinned.locator(".sidebar-session-group-toggle").click();
      await expect
        .poll(() =>
          page.evaluate(
            ({ databaseName, storeName }) =>
              new Promise<boolean>((resolve, reject) => {
                const open = indexedDB.open(databaseName);
                open.addEventListener("error", () =>
                  reject(open.error ?? new Error("Sidebar snapshot open failed")),
                );
                open.addEventListener("success", () => {
                  const database = open.result;
                  const transaction = database.transaction(storeName, "readonly");
                  const request = transaction.objectStore(storeName).getAll();
                  transaction.addEventListener("complete", () => {
                    database.close();
                    resolve(
                      request.result.some((record) =>
                        record.model.collapsedSections.includes("pinned"),
                      ),
                    );
                  });
                  transaction.addEventListener("abort", () => {
                    database.close();
                    reject(transaction.error ?? new Error("Sidebar snapshot read failed"));
                  });
                });
              }),
            { databaseName: CHAT_SNAPSHOT_DB_NAME, storeName: SIDEBAR_SNAPSHOT_STORE_NAME },
          ),
        )
        .toBe(true);
      await page.reload();
      await shortcut.waitFor();
      await pinned.locator('.sidebar-session-group-toggle[aria-expanded="false"]').waitFor();
      await pinned.locator(".sidebar-session-group-toggle").click();
      await row.waitFor();
      expect(
        await pinned.locator(`.sidebar-recent-session[data-session-key="${key}"]`).count(),
      ).toBe(1);
      await shortcut.click({ button: "right" });
      await sidebar.locator('.sidebar-rail-pin-menu [data-value="remove"]').click();
      await expect.poll(() => shortcut.count()).toBe(0);
      expect(
        await pinned.locator(`.sidebar-recent-session[data-session-key="${key}"]`).count(),
      ).toBe(1);
      await row.dragTo(rail);
      await shortcut.waitFor();
      await row.hover();
      await row.getByRole("button", { name: "Unpin session", exact: true }).click();
      await expect.poll(() => pinned.count()).toBe(0);
      expect(await shortcut.count()).toBe(1);
      expect(await row.count()).toBe(1);
      expect(await gateway.getRequests("sessions.patch")).toEqual([]);
    });
  });
});
