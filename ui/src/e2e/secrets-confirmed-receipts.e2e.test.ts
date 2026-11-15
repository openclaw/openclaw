import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
const suite = createControlUiE2eSuite({ name: "Secrets confirmed receipts" });
const entry = {
  name: "AUDIT_API_KEY",
  kind: "secret",
  allowedHosts: ["api.example.test"],
  scopeKind: "team",
  scopeId: "",
  createdAtMs: 1,
  updatedAtMs: 2,
};
const methods = ["secrets.store.list", "secrets.store.set", "secrets.store.delete"];
suite.define(() => {
  it("keeps an acknowledged save distinct from its failed inventory refresh", () =>
    suite.withPage({ viewport: { width: 1280, height: 1000 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: methods,
        methodResponses: {
          "secrets.store.list": { entries: [] },
          "secrets.store.set": { ok: true, reloaded: true, warningCount: 1 },
        },
      });
      await page.goto(suite.server.baseUrl + "settings/secrets");
      await gateway.waitForRequest("secrets.store.list");
      await page.getByRole("button", { name: "Add", exact: true }).click();
      const dialog = page.locator('openclaw-modal-dialog[label="Add secret"]');
      await dialog.locator('dialog[data-phase="open"]').waitFor();
      await dialog.getByLabel("Name", { exact: true }).fill(entry.name);
      await dialog.getByLabel("Value", { exact: true }).fill("synthetic-value-not-a-credential");
      await dialog.locator('textarea[name="allowed-hosts"]').fill("api.example.test");
      await gateway.deferNext("secrets.store.list");
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await gateway.waitForRequest("secrets.store.set");
      await expect
        .poll(async () => (await gateway.getRequests("secrets.store.list")).length)
        .toBe(2);
      await gateway.rejectDeferred("secrets.store.list", {
        message: "Synthetic inventory refresh unavailable",
      });
      await page
        .locator('.secrets-store__message[role="alert"]')
        .filter({ hasText: "Synthetic inventory refresh unavailable" })
        .waitFor();
      await expect
        .poll(
          async () =>
            (await dialog.count()) === 0 ||
            (await dialog.getByRole("button", { name: "Save", exact: true }).isEnabled()),
        )
        .toBe(true);
      expect.soft(await dialog.count(), "a confirmed save is not an unsaved draft").toBe(0);
      expect
        .soft(
          await page.locator(".settings-empty").count(),
          "a saved entry invalidates the old empty inventory",
        )
        .toBe(0);
      expect
        .soft(
          await page
            .getByRole("status")
            .filter({ hasText: "Saved AUDIT_API_KEY as Protected secret" })
            .count(),
          "retain acknowledged save and runtime warning receipt",
        )
        .toBe(1);
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        const file = suite.artifactDir + "/saved-refresh-failed.png";
        await page.screenshot({ path: file });
        console.log("Secrets receipt capture: " + file);
      }
      if (await dialog.count()) {
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      }
      await gateway.setMethodResponse("secrets.store.list", { entries: [entry] });
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await page.getByRole("listitem", { name: entry.name, exact: true }).waitFor();
      expect(await gateway.getRequests("secrets.store.set")).toHaveLength(1);
      expect(await page.content()).not.toContain("synthetic-value-not-a-credential");
    }));
  it("keeps an acknowledged deletion distinct from its failed inventory refresh", () =>
    suite.withPage({ viewport: { width: 1280, height: 1000 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: methods,
        methodResponses: {
          "secrets.store.list": { entries: [entry] },
          "secrets.store.delete": { ok: true, reloaded: false },
        },
      });
      await page.goto(suite.server.baseUrl + "settings/secrets");
      const row = page.getByRole("listitem", { name: entry.name, exact: true });
      await row.waitFor();
      await row.hover();
      await row.getByRole("button", { name: "Actions: " + entry.name, exact: true }).click();
      await row.locator('.oc-menu-item[data-value="delete"]').click();
      const confirmation = page.locator('openclaw-modal-dialog[label="Delete AUDIT_API_KEY?"]');
      await confirmation.locator('dialog[data-phase="open"]').waitFor();
      await gateway.deferNext("secrets.store.list");
      await confirmation.getByRole("button", { name: "Delete", exact: true }).click();
      await gateway.waitForRequest("secrets.store.delete");
      await expect
        .poll(async () => (await gateway.getRequests("secrets.store.list")).length)
        .toBe(2);
      await gateway.rejectDeferred("secrets.store.list", {
        message: "Synthetic inventory refresh unavailable",
      });
      await page
        .getByRole("alert")
        .filter({ hasText: "Synthetic inventory refresh unavailable" })
        .waitFor();
      expect
        .soft(
          await page.getByRole("status").filter({ hasText: "Deleted AUDIT_API_KEY." }).count(),
          "retain acknowledged deletion",
        )
        .toBe(1);
      await gateway.setMethodResponse("secrets.store.list", { entries: [] });
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await page.locator(".settings-empty").filter({ hasText: "No secrets yet." }).waitFor();
      expect(await gateway.getRequests("secrets.store.delete")).toHaveLength(1);
    }));
  it("does not call a fully acknowledged bulk save an unfinished import", () =>
    suite.withPage({ viewport: { width: 1280, height: 1000 } }, async ({ page }) => {
      const failure = {
        __mockError: { code: "UNAVAILABLE", message: "Synthetic inventory refresh unavailable" },
      };
      const gateway = await installMockGateway(page, {
        featureMethods: methods,
        methodResponses: {
          "secrets.store.list": {
            sequence: [{ entries: [] }, failure, failure, { entries: [entry] }],
          },
          "secrets.store.set": { ok: true, reloaded: false },
        },
      });
      await page.goto(suite.server.baseUrl + "settings/secrets");
      await gateway.waitForRequest("secrets.store.list");
      await page.getByRole("button", { name: "Bulk add", exact: true }).click();
      const dialog = page.locator('openclaw-modal-dialog[label="Bulk add"]');
      await dialog.locator('dialog[data-phase="open"]').waitFor();
      await dialog
        .getByRole("textbox", { name: "Value", exact: true })
        .fill("AUDIT_API_KEY=synthetic-value-not-a-credential");
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await expect
        .poll(async () => (await gateway.getRequests("secrets.store.list")).length)
        .toBe(3);
      await page
        .locator('.secrets-store__message[role="alert"]')
        .filter({ hasText: "Synthetic inventory refresh unavailable" })
        .waitFor();
      await expect
        .poll(
          async () =>
            (await dialog.count()) === 0 ||
            (await dialog.getByRole("button", { name: "Save", exact: true }).isEnabled()),
        )
        .toBe(true);
      expect.soft(await dialog.count(), "all bulk writes were acknowledged").toBe(0);
      expect
        .soft(
          await page.locator(".settings-empty").count(),
          "completed import invalidates the old empty inventory",
        )
        .toBe(0);
      expect
        .soft(
          await page.getByRole("status").filter({ hasText: "Saved 1 entries" }).count(),
          "completed bulk receipt survives list failure",
        )
        .toBe(1);
      if (await dialog.count()) {
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      }
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await page.getByRole("listitem", { name: entry.name, exact: true }).waitFor();
      expect(await gateway.getRequests("secrets.store.set")).toHaveLength(1);
    }));
});
