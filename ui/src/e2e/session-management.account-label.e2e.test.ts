import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import {
  waitForControlUiGatewayReady,
  waitForControlUiGatewayReconnecting,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import * as ui from "./session-management.compact.test-support.ts";
import {
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  trimmedTextContents,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();
const defaultKey = "agent:main:telegram:direct:42";
const cardsKey = "agent:main:telegram:cards:direct:42";

// Mirror Gateway direct rows: origin displayName + route accountId, no stored label.
function gatewayDirectRow(key: string, updatedAt: number, accountId?: string) {
  return { ...sessionRow(key, "Alice", updatedAt), accountId, label: undefined };
}

async function openDirectSession(page: Page, paired = false) {
  const key = paired ? defaultKey : cardsKey;
  await ui.installSessionRows(
    page,
    [...(paired ? [gatewayDirectRow(defaultKey, 2)] : []), gatewayDirectRow(cardsKey, 1, "cards")],
    { sessionKey: key },
  );
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
}

async function openRowRename(page: Page, row: Locator) {
  await row.hover();
  await row.click({ button: "right" });
  await ui.menuItem(page, "Rename…", false).click();
}

suite.define(() => {
  it.each(["sidebar", "header"] as const)(
    "disambiguates account labels and opens %s rename on the stored label",
    (surface) =>
      suite.withPage(
        {
          ...createControlUiE2eContextOptions(),
          colorScheme: surface === "sidebar" ? "dark" : undefined,
        },
        async ({ page }) => {
          await openDirectSession(page, surface === "sidebar");
          let field: Locator;
          if (surface === "header") {
            const title = page.locator(".chat-pane__session-title-button");
            await ui.expectText(title, "Alice · cards");
            await title.click();
            field = page.locator(".chat-pane__session-title-input");
          } else {
            const defaultRow = page.locator(`[data-session-key="${defaultKey}"]`);
            await defaultRow.waitFor({ state: "visible", timeout: 10_000 });
            await expect
              .poll(() => trimmedTextContents(defaultRow.locator(".sidebar-recent-session__name")))
              .toEqual(["Alice"]);
            const row = page.locator(`[data-session-key="${cardsKey}"]`);
            await row.waitFor({ state: "visible", timeout: 10_000 });
            await expect
              .poll(() => trimmedTextContents(row.locator(".sidebar-recent-session__name")))
              .toEqual(["Alice · cards"]);
            await openRowRename(page, row);
            field = page
              .locator('openclaw-modal-dialog[label="Rename session"]')
              .getByRole("textbox", { name: "Rename session" });
          }
          await field.waitFor({ state: "visible" });
          expect(await field.inputValue()).toBe("");
        },
      ),
  );

  it.each(["sidebar", "sessions", "header"] as const)(
    "edits a generated dashboard title through the %s",
    async (surface) => {
      const key = "agent:main:dashboard:generated-title";
      const generatedTitle = "Repository activity dashboard";
      await ui.withSessionPage(suite, async (page) => {
        const original = {
          ...sessionRow(key, generatedTitle, Date.now()),
          label: undefined,
          ...(surface === "sessions"
            ? { displayName: undefined, derivedTitle: generatedTitle }
            : {}),
        };
        const gateway = await ui.installSessionRows(page, [original], { sessionKey: key });

        await page.goto(
          surface === "sessions"
            ? `${suite.server.baseUrl}sessions`
            : controlUiSessionUrl(suite.server.baseUrl, key),
        );
        const row =
          surface === "sessions"
            ? page.locator(".sessions-table tbody tr", {
                has: page.getByRole("checkbox", { name: `Select session: ${key}`, exact: true }),
              })
            : page.locator(`.sidebar-recent-session[data-session-key="${key}"]`);
        await row.waitFor({ state: "visible" });
        const openRename = async () => {
          if (surface === "header") {
            await page.locator(".chat-pane__session-title-button").click();
          } else {
            await openRowRename(page, row);
          }
          await field.waitFor({ state: "visible" });
          await expect
            .poll(() => field.evaluate((input) => document.activeElement === input))
            .toBe(true);
        };
        const field = page.locator(
          surface === "header"
            ? ".chat-pane__session-title-input"
            : 'openclaw-modal-dialog[label="Rename session"] input',
        );
        await openRename();
        expect(await field.inputValue()).toBe(generatedTitle);
        await page.keyboard.press("Enter");
        await field.waitFor({ state: "detached" });
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);

        await openRename();
        await page.keyboard.press("ArrowRight");
        await page.keyboard.type(" updated");
        expect(await field.inputValue()).toBe(`${generatedTitle} updated`);
        await page.keyboard.press("Escape");
        await field.waitFor({ state: "detached" });
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);

        await openRename();
        await page.keyboard.press("ArrowRight");
        await page.keyboard.type(" updated");
        if (surface === "header") {
          await page.keyboard.press("Enter");
        } else {
          await ui.button(page.locator("openclaw-modal-dialog"), "Save", false).click();
        }
        const patchRequest = await gateway.waitForRequest("sessions.patch");
        expect(patchRequest.params).toMatchObject({
          key,
          expectedSessionId: original.sessionId,
          label: `${generatedTitle} updated`,
        });
        await ui.expectText(row, `${generatedTitle} updated`);
        await openRename();
        await ui.pollValue(field).toBe(`${generatedTitle} updated`);
        await field.fill("");
        await field.press("Enter");
        await ui.pollText(row).not.toContain(`${generatedTitle} updated`);
        await openRename();
        await ui.pollValue(field).toBe(generatedTitle);
        if (surface === "sidebar" || surface === "header") {
          await gateway.setOnline(false);
          await waitForControlUiGatewayReconnecting(page);
          expect(await field.inputValue()).toBe(generatedTitle);
          expect(await field.isEnabled()).toBe(true);
          await field.fill(`${generatedTitle} queued`);
          if (surface === "header") {
            await field.press("Enter");
          } else {
            const dialog = page.getByRole("dialog", { name: "Rename session", exact: true });
            await expect.poll(() => ui.button(dialog, "Save").isEnabled()).toBe(true);
            await ui.button(dialog, "Save").click();
          }
          await field.waitFor({ state: "detached" });
          await ui.expectText(row, `${generatedTitle} queued`);
          expect(await gateway.getRequests("sessions.patch")).toHaveLength(2);
          await gateway.setOnline(true);
          await waitForControlUiGatewayReady(page);
          await expect
            .poll(async () => (await gateway.getRequests("sessions.patch")).length)
            .toBe(3);
          expect((await gateway.getRequests("sessions.patch"))[2]?.params).toMatchObject({
            key,
            expectedSessionId: original.sessionId,
            label: `${generatedTitle} queued`,
          });
          await ui.expectText(row, `${generatedTitle} queued`);
        } else {
          await gateway.closeLatest();
        }
        await field.waitFor({ state: "detached" });
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(
          surface === "sessions" ? 2 : 3,
        );
      });
    },
  );
});
