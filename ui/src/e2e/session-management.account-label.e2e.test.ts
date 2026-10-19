import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  waitForControlUiGatewayReady,
  waitForControlUiGatewayReconnecting,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  captureUiProof,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
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
  await installMockGateway(page, {
    methodResponses: {
      "sessions.list": sessionsListResponse([
        ...(paired ? [gatewayDirectRow(defaultKey, 2)] : []),
        gatewayDirectRow(cardsKey, 1, "cards"),
      ]),
    },
    sessionKey: key,
  });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
}

suite.define(() => {
  it("disambiguates same-name sessions from different Telegram accounts in the sidebar", async () => {
    await suite.withPage(
      { ...createControlUiE2eContextOptions(), colorScheme: "dark" },
      async ({ page }) => {
        await openDirectSession(page, true);
        const defaultRow = page.locator(`[data-session-key="${defaultKey}"]`);
        const cardsRow = page.locator(`[data-session-key="${cardsKey}"]`);
        await defaultRow.waitFor({ state: "visible", timeout: 10_000 });
        await cardsRow.waitFor({ state: "visible" });
        await expect
          .poll(() => trimmedTextContents(defaultRow.locator(".sidebar-recent-session__name")))
          .toEqual(["Alice"]);
        await expect
          .poll(() => trimmedTextContents(cardsRow.locator(".sidebar-recent-session__name")))
          .toEqual(["Alice · cards"]);
        await captureUiProof(suite, page, "telegram-account-session-labels.png");
      },
    );
  });

  it("opens rename on the stored label, not the account-decorated name", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      await openDirectSession(page);
      const row = page.locator(`[data-session-key="${cardsKey}"]`);
      await row.waitFor({ state: "visible", timeout: 10_000 });
      await expect
        .poll(() => trimmedTextContents(row.locator(".sidebar-recent-session__name")))
        .toEqual(["Alice · cards"]);

      await row.hover();
      await row.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Rename…" }).click();
      const field = page
        .locator('openclaw-modal-dialog[label="Rename session"]')
        .getByRole("textbox", { name: "Rename session" });
      await field.waitFor({ state: "visible" });
      // Never persist the rendered account discriminator as a user label.
      expect(await field.inputValue()).toBe("");
    });
  });

  it("opens chat pane rename on the stored label, not the account-decorated title", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      await openDirectSession(page);
      const title = page.locator(".chat-pane__session-title-button");
      await expect.poll(() => title.textContent()).toContain("Alice · cards");
      await title.click();
      const field = page.locator(".chat-pane__session-title-input");
      await field.waitFor({ state: "visible" });
      expect(await field.inputValue()).toBe("");
    });
  });

  it.each(["sidebar", "sessions", "header"] as const)(
    "edits a generated dashboard title through the %s",
    async (surface) => {
      const key = "agent:main:dashboard:generated-title";
      const generatedTitle = "Repository activity dashboard";
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const original = {
          ...sessionRow(key, generatedTitle, Date.now()),
          label: undefined,
          ...(surface === "sessions"
            ? { displayName: undefined, derivedTitle: generatedTitle }
            : {}),
        };
        const gateway = await installMockGateway(page, {
          methodResponses: { "sessions.list": sessionsListResponse([original]) },
          sessionKey: key,
        });

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
            await row.hover();
            await row.click({ button: "right" });
            await page.getByRole("menuitem", { name: "Rename…" }).click();
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
        await captureUiProof(suite, page, `${surface}-generated-title.png`);
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
          await page.locator("openclaw-modal-dialog").getByRole("button", { name: "Save" }).click();
        }
        const patchRequest = await gateway.waitForRequest("sessions.patch");
        expect(patchRequest.params).toMatchObject({
          key,
          expectedSessionId: original.sessionId,
          label: `${generatedTitle} updated`,
        });
        await expect.poll(() => row.textContent()).toContain(`${generatedTitle} updated`);
        await openRename();
        await expect.poll(() => field.inputValue()).toBe(`${generatedTitle} updated`);
        await captureUiProof(suite, page, `${surface}-renamed-title.png`);
        await field.fill("");
        await field.press("Enter");
        await expect.poll(() => row.textContent()).not.toContain(`${generatedTitle} updated`);
        await openRename();
        await expect.poll(() => field.inputValue()).toBe(generatedTitle);
        if (surface === "sidebar") {
          const dialog = page.getByRole("dialog", { name: "Rename session", exact: true });
          await gateway.setOnline(false);
          await waitForControlUiGatewayReconnecting(page);
          expect(await field.inputValue()).toBe(generatedTitle);
          expect(await field.isEnabled()).toBe(true);
          await expect
            .poll(() => dialog.getByRole("button", { name: "Save", exact: true }).isEnabled())
            .toBe(false);
          await gateway.setOnline(true);
          await waitForControlUiGatewayReady(page);
          expect(await field.inputValue()).toBe(generatedTitle);
          await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        } else {
          await gateway.closeLatest();
        }
        await field.waitFor({ state: "detached" });
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(2);
      });
    },
  );
});
