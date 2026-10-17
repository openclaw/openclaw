import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  createControlUiMockSameOriginGatewayScript,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { workboardUi } from "../test-helpers/control-ui-workboard-fixture.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Modal completion actions" });
const viewports = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
  { name: "narrow", width: 320, height: 844 },
] as const;

// Browser layout is the contract: neither the footer tag nor a CSS declaration
// proves that wrapped buttons stay right-aligned, visible and inside their form.
async function inspectActions(page: Page, modal: Locator, selector: string, name: string) {
  const dialog = modal.getByRole("dialog");
  const footer = modal.locator(selector).last();
  const frame = await takeControlUiScreenshotFrame(page, dialog, [footer], {
    animations: "disabled",
    elements: [dialog],
    scrollTo: footer,
  });
  await writeFile(path.join(suite.artifactDir, name + ".png"), frame.png);
  await writeFile(path.join(suite.artifactDir, name + "-dialog.png"), frame.elements[0]!.png);
  const geometry = await footer.evaluate((row) => {
    const bounds = (element: Element) => {
      const r = element.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    };
    const card = row.parentElement!;
    const cardStyle = getComputedStyle(card);
    const rowStyle = getComputedStyle(row);
    return {
      row: bounds(row),
      card: bounds(card),
      rowPadding: Number.parseFloat(rowStyle.paddingRight),
      paddingRight: Number.parseFloat(cardStyle.paddingRight),
      paddingBottom: Number.parseFloat(cardStyle.paddingBottom),
      controls: [...row.querySelectorAll("button")]
        .filter((button) => button.getBoundingClientRect().height > 0)
        .map((button) => {
          const rect = button.getBoundingClientRect();
          return {
            label: button.textContent?.trim(),
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
          };
        }),
      following: [...card.children]
        .slice([...card.children].indexOf(row) + 1)
        .filter((child) => child.getBoundingClientRect().height > 0).length,
      scrollWidth: card.scrollWidth,
      clientWidth: card.clientWidth,
      viewport: { width: innerWidth, height: innerHeight },
    };
  });
  await writeFile(path.join(suite.artifactDir, name + ".json"), JSON.stringify(geometry, null, 2));
  return geometry;
}

function expectCompletionPlacement(geometry: Awaited<ReturnType<typeof inspectActions>>) {
  expect(geometry.following).toBe(0);
  expect(geometry.controls.length).toBeGreaterThan(0);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
  expect(
    Math.abs(geometry.row.right - (geometry.card.right - geometry.paddingRight)),
  ).toBeLessThanOrEqual(3);
  expect(
    Math.abs(geometry.row.bottom - (geometry.card.bottom - geometry.paddingBottom)),
  ).toBeLessThanOrEqual(4);
  const rows = new Map<number, number[]>();
  for (const control of geometry.controls) {
    expect(control.left).toBeGreaterThanOrEqual(geometry.row.left - 1);
    expect(control.right).toBeLessThanOrEqual(geometry.row.right + 1);
    expect(control.top).toBeGreaterThanOrEqual(0);
    expect(control.bottom).toBeLessThanOrEqual(geometry.viewport.height);
    const line = Math.round(control.top);
    rows.set(line, [...(rows.get(line) ?? []), control.right]);
  }
  for (const edges of rows.values()) {
    expect(
      Math.abs(Math.max(...edges) - (geometry.row.right - geometry.rowPadding)),
    ).toBeLessThanOrEqual(3);
  }
}

suite.define(() => {
  it("keeps native Workboard card completion controls visible at narrow widths", async () =>
    suite.withPage({ viewport: viewports[2], reducedMotion: "reduce" }, async ({ page }) => {
      await page.addInitScript(createControlUiMockSameOriginGatewayScript());
      const config = { plugins: { entries: { workboard: { enabled: true } } } };
      const gateway = await installMockGateway(page, {
        ...workboardUi,
        methodResponses: {
          "config.get": {
            config,
            hash: "modal-proof",
            path: "/synthetic/openclaw.json",
            raw: JSON.stringify(config),
            resolved: config,
            sourceConfig: config,
          },
          "workboard.cards.list": {
            cards: [],
            statuses: ["todo"],
            boards: [{ id: "default", total: 0, active: 0, archived: 0, byStatus: {} }],
          },
        },
      });
      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await page.goto(`${suite.server.baseUrl}workboard`);
        await gateway.waitForRequest("workboard.cards.list");
        await page
          .locator(".workboard-heading__actions")
          .getByRole("button", { name: /New card/u })
          .click();
        const dialog = page.getByRole("dialog", { name: "New card", exact: true });
        await expect
          .poll(() => dialog.evaluate((element) => getComputedStyle(element).opacity))
          .toBe("1");
        // Before scrolling, the card body must absorb overflow, not the shell.
        const placement = await dialog.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const form = element.querySelector<HTMLFormElement>("form.workboard-card-draft")!;
          const actions = [
            ...form.querySelectorAll<HTMLButtonElement>("openclaw-modal-actions button"),
          ];
          return {
            count: actions.length,
            contained: actions.every((button) => {
              const rect = button.getBoundingClientRect();
              return (
                rect.top >= bounds.top &&
                rect.bottom <= bounds.bottom + 1 &&
                rect.left >= bounds.left &&
                rect.right <= bounds.right + 1
              );
            }),
            submitOwned: actions.some((button) => button.type === "submit" && button.form === form),
          };
        });
        expect(placement).toEqual({ count: 2, contained: true, submitOwned: true });
        await dialog
          .locator("openclaw-modal-actions")
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
        await expect.poll(() => dialog.isVisible()).toBe(false);
      }
      expect(await gateway.getRequests("workboard.cards.create")).toHaveLength(0);
    }));

  it("keeps update confirmation and progress actions bottom-right without starting early", async () =>
    suite.withPage({ viewport: viewports[0], reducedMotion: "reduce" }, async ({ page }) => {
      const available = { channel: "stable", currentVersion: "1.0.0", latestVersion: "2.0.0" };
      const gateway = await installMockGateway(page, { deferredMethods: ["update.run"] });
      await page.goto(suite.server.baseUrl + "chat");
      await gateway.waitForRequest("chat.startup");
      await gateway.setMethodResponse("update.status", { updateAvailable: available });
      await gateway.emitGatewayEvent("update.available", { updateAvailable: available });
      await page.locator(".sidebar-issues-button:visible").click();
      const issue = page.locator(
        'openclaw-sidebar-update-card[data-attention-kind="updateAvailable"]',
      );
      await issue.locator("summary").click();
      await issue.locator(".sidebar-update-card__action").click();
      const modal = page.locator('openclaw-modal-dialog[label="Update Gateway"]');
      const confirm = await inspectActions(page, modal, ".exec-approval-actions", "update-confirm");
      expect(await gateway.getRequests("update.run")).toHaveLength(0);
      await modal.getByRole("button", { name: "Update and restart", exact: true }).click();
      await gateway.waitForRequest("update.run");
      await modal.getByRole("button", { name: "Updating…", exact: true }).waitFor();
      const working = await inspectActions(page, modal, ".exec-approval-actions", "update-working");
      expect(await gateway.getRequests("update.run")).toHaveLength(1);
      expectCompletionPlacement(confirm);
      expectCompletionPlacement(working);
    }));

  for (const viewport of viewports) {
    it("keeps native secret submission and bulk actions reachable on " + viewport.name, async () =>
      suite.withPage({ viewport, reducedMotion: "reduce" }, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: ["secrets.store.list", "secrets.store.set", "secrets.store.delete"],
          methodResponses: {
            "secrets.store.list": {
              entries: [
                {
                  name: "SERVICE_URL",
                  kind: "env",
                  value: "https://service.test",
                  scopeKind: "team",
                  scopeId: "",
                  createdAtMs: 1,
                  updatedAtMs: 2,
                  updatedBy: "Proof operator",
                },
              ],
            },
            "secrets.store.set": { ok: true, reloaded: false },
          },
        });
        await page.goto(suite.server.baseUrl + "settings/secrets");
        await page.getByRole("heading", { name: "Secrets", level: 1, exact: true }).waitFor();
        await page.getByRole("button", { name: "Add", exact: true }).click();
        const add = page.locator('openclaw-modal-dialog[label="Add"]');
        await add.getByLabel("Name", { exact: true }).fill("DEPLOY_REGION");
        await add.getByLabel("Value", { exact: true }).fill("eu-west-1");
        const addition = await inspectActions(
          page,
          add,
          ".secrets-store-dialog__actions",
          "secrets-add",
        );
        await add.getByLabel("Name", { exact: true }).press("Enter");
        await gateway.waitForRequest("secrets.store.set");
        await add.waitFor({ state: "detached" });
        expect((await gateway.getRequests("secrets.store.set"))[0]?.params).toMatchObject({
          name: "DEPLOY_REGION",
          value: "eu-west-1",
        });
        const row = page.getByRole("row", { name: "SERVICE_URL", exact: true });
        await row.getByRole("button", { name: "Actions: SERVICE_URL" }).click();
        await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
        const edit = page.locator('openclaw-modal-dialog[label="Edit"]');
        await edit.getByLabel("Value", { exact: true }).fill("https://updated.test");
        const editing = await inspectActions(
          page,
          edit,
          ".secrets-store-dialog__actions",
          "secrets-edit",
        );
        await edit.getByRole("button", { name: "Save", exact: true }).click();
        await edit.waitFor({ state: "detached" });
        expect(await gateway.getRequests("secrets.store.set")).toHaveLength(2);
        await page.getByRole("button", { name: "Bulk Add", exact: true }).click();
        const bulk = page.locator('openclaw-modal-dialog[label="Bulk Add"]');
        await bulk
          .getByRole("textbox", { name: "Value", exact: true })
          .fill(["SERVICE_URL=https://service.test", "SERVICE_API_KEY=fixture-only"].join("\n"));
        const bulkActions = await inspectActions(
          page,
          bulk,
          ".secrets-store-dialog__actions",
          "secrets-bulk",
        );
        await bulk.getByRole("button", { name: "Save", exact: true }).click();
        await bulk.waitFor({ state: "detached" });
        expect(await gateway.getRequests("secrets.store.set")).toHaveLength(4);
        for (const geometry of [addition, editing, bulkActions]) {
          expectCompletionPlacement(geometry);
          // These short English labels fit one row even at 320px; do not stretch
          // both actions into the old mobile full-width column.
          expect(
            Math.abs(geometry.controls[0]!.top - geometry.controls[1]!.top),
          ).toBeLessThanOrEqual(2);
        }
      }),
    );
  }
});
