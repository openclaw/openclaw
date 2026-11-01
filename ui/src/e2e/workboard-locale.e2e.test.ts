import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { configResponse } from "./appearance-prefs.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installWorkboardPage } from "./workboard-page.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Workboard plugin locale catalog",
  startServerBeforeBrowser: true,
});
const named = (host: Page | Locator, role: Parameters<Page["getByRole"]>[0], name: string) =>
  host.getByRole(role, { name, exact: true });

suite.define(() => {
  it.each(["en", "fr"])(
    "loads plugin copy in %s and preserves drafts across a live locale switch",
    async (locale) => {
      await suite.withPage(
        { viewport: { width: 1280, height: 1000 }, serviceWorkers: "block" },
        async ({ page }) => {
          const columns = [
            {
              id: "working",
              label: "Working",
              description: "Active work",
              match: { run: ["active"] },
            },
            { id: "done", label: "Done", description: "Completed work", fallback: true },
          ];
          const board = {
            id: "sessions",
            name: "Team sessions",
            kind: "sessions",
            sessions: { columns },
            total: 0,
            active: 0,
            archived: 0,
            byStatus: {},
          };
          const gateway = await installWorkboardPage(page, suite.server.baseUrl, "sessions", {
            "workboard.boards.list": { boards: [board] },
            "workboard.cards.list": { boards: [board], cards: [] },
            "workboard.sessionsBoard.read": { board, columns, sessions: [], people: [] },
          });
          await page.addInitScript((initialLocale) => {
            localStorage.setItem("openclaw.i18n.locale", initialLocale);
          }, locale);
          await page.goto(`${suite.server.baseUrl}new`);
          await page
            .locator('[data-sidebar-entry="plugin:workboard/board-sessions"]')
            .getByRole("link", { name: "Team sessions", exact: true })
            .click();
          await gateway.waitForRequest("workboard.sessionsBoard.read");
          await page.locator(".workboard-page-title").hover();
          await named(
            page,
            "button",
            locale === "fr" ? "Modifier le tableau" : "Edit board",
          ).click();
          const form = page.locator(".workboard-board-draft");
          const column = form.locator('[data-column-id="working"]');
          await column.waitFor();
          expect(
            await named(column, "combobox", locale === "fr" ? "Couleur" : "Color").count(),
          ).toBe(1);
          expect(await form.textContent()).not.toContain("workboard.boardColor");
          await named(form, "button", locale === "fr" ? "Annuler" : "Cancel").waitFor();
          if (locale === "fr") {
            const name = form.locator(".workboard-board-draft__name input");
            await name.fill("Unsaved locale draft");
            // Exercise the real host locale owner while the compiled plugin remains mounted.
            await gateway.setMethodResponse(
              "config.get",
              configResponse({ locale: "en" }, "workboard-locale-en"),
            );
            await gateway.emitGatewayEvent("config.changed", { hash: "workboard-locale-en" });
            await named(form, "button", "Cancel").waitFor();
            expect(await name.inputValue()).toBe("Unsaved locale draft");
            expect(await named(column, "combobox", "Color").count()).toBe(1);
          }
        },
      );
    },
  );
});
