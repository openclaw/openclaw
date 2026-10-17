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
const exactButton = (host: Page | Locator, name: string) =>
  host.getByRole("button", { name, exact: true });
const modalFor = (page: Page, label: string) =>
  page.locator(`openclaw-modal-dialog[label="${label}"]`);
async function inspectActions(page: Page, modal: Locator, selector: string) {
  const dialog = modal.getByRole("dialog");
  const footer = modal.locator(selector).last();
  await takeControlUiScreenshotFrame(page, dialog, [footer], {
    animations: "disabled",
    elements: [dialog],
    scrollTo: footer,
  });
  const geometry = await footer.evaluate((row) => {
    const card = row.parentElement!;
    const box = row.getBoundingClientRect();
    const cardBox = card.getBoundingClientRect();
    const style = getComputedStyle(card);
    const edge = box.right - Number.parseFloat(getComputedStyle(row).paddingRight);
    const controls = [...row.querySelectorAll("button")]
      .map((button) => button.getBoundingClientRect())
      .filter((rect) => rect.height > 0);
    const rowEnds = new Map<number, number>();
    for (const rect of controls) {
      const line = Math.round(rect.top);
      rowEnds.set(line, Math.max(rowEnds.get(line) ?? -Infinity, rect.right));
    }
    return {
      tops: controls.map((rect) => rect.top),
      footerLast: ![...card.children]
        .slice([...card.children].indexOf(row) + 1)
        .some((child) => child.getBoundingClientRect().height > 0),
      noOverflow: card.scrollWidth <= card.clientWidth + 1,
      rightAligned:
        Math.abs(box.right - cardBox.right + Number.parseFloat(style.paddingRight)) <= 3,
      bottomAligned:
        Math.abs(box.bottom - cardBox.bottom + Number.parseFloat(style.paddingBottom)) <= 4,
      contained: controls.every(
        (rect) =>
          rect.left >= box.left - 1 &&
          rect.right <= box.right + 1 &&
          rect.top >= 0 &&
          rect.bottom <= innerHeight,
      ),
      rowsAligned: [...rowEnds.values()].every((right) => Math.abs(right - edge) <= 3),
    };
  });
  expect(geometry).toMatchObject({
    footerLast: true,
    noOverflow: true,
    rightAligned: true,
    bottomAligned: true,
    contained: true,
    rowsAligned: true,
  });
  expect(geometry.tops.length).toBeGreaterThan(0);
  return geometry.tops;
}

async function submitSecretDialog(page: Page, label: string, enter = false) {
  const modal = modalFor(page, label);
  const geometry = await inspectActions(page, modal, ".secrets-store-dialog__actions");
  // These short labels fit one row even at 320px; never stretch into a full-width column.
  expect(Math.abs(geometry[0]! - geometry[1]!)).toBeLessThanOrEqual(2);
  if (enter) {
    await modal.getByLabel("Name", { exact: true }).press("Enter");
  } else {
    await exactButton(modal, "Save").click();
  }
  await modal.waitFor({ state: "detached" });
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
        await exactButton(dialog.locator("openclaw-modal-actions"), "Cancel").click();
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
      const modal = modalFor(page, "Update Gateway");
      await inspectActions(page, modal, ".exec-approval-actions");
      expect(await gateway.getRequests("update.run")).toHaveLength(0);
      await exactButton(modal, "Update and restart").click();
      await gateway.waitForRequest("update.run");
      await exactButton(modal, "Updating…").waitFor();
      await inspectActions(page, modal, ".exec-approval-actions");
      expect(await gateway.getRequests("update.run")).toHaveLength(1);
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
        await exactButton(page, "Add").click();
        const add = modalFor(page, "Add");
        await add.getByLabel("Name", { exact: true }).fill("DEPLOY_REGION");
        await add.getByLabel("Value", { exact: true }).fill("eu-west-1");
        await submitSecretDialog(page, "Add", true);
        await gateway.waitForRequest("secrets.store.set");
        expect((await gateway.getRequests("secrets.store.set"))[0]?.params).toMatchObject({
          name: "DEPLOY_REGION",
          value: "eu-west-1",
        });
        const row = page.getByRole("row", { name: "SERVICE_URL", exact: true });
        await row.getByRole("button", { name: "Actions: SERVICE_URL" }).click();
        await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
        const edit = modalFor(page, "Edit");
        await edit.getByLabel("Value", { exact: true }).fill("https://updated.test");
        await submitSecretDialog(page, "Edit");
        expect(await gateway.getRequests("secrets.store.set")).toHaveLength(2);
        await exactButton(page, "Bulk Add").click();
        const bulk = modalFor(page, "Bulk Add");
        await bulk
          .getByRole("textbox", { name: "Value", exact: true })
          .fill(["SERVICE_URL=https://service.test", "SERVICE_API_KEY=fixture-only"].join("\n"));
        await submitSecretDialog(page, "Bulk Add");
        expect(await gateway.getRequests("secrets.store.set")).toHaveLength(4);
      }),
    );
  }
});
