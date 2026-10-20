import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { workboardUi } from "../test-helpers/control-ui-workboard-fixture.ts";
import { configResponse } from "./appearance-prefs.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Workboard plugin locale catalog",
  startServerBeforeBrowser: true,
});

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
          const gateway = await installMockGateway(page, {
            ...workboardUi,
            methodResponses: {
              "workboard.boards.list": { boards: [board] },
              "workboard.cards.list": { boards: [board], cards: [] },
              "workboard.sessionsBoard.read": { board, columns, sessions: [], people: [] },
            },
          });
          await page.addInitScript(
            ({ key, locale: initialLocale }) => {
              localStorage.setItem("openclaw.i18n.locale", initialLocale);
              localStorage.setItem(
                key,
                JSON.stringify({
                  railShortcuts: ["route:agents-home", "plugin:workboard/board-sessions"],
                }),
              );
            },
            { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl), locale },
          );
          await page.goto(`${suite.server.baseUrl}new`);
          await page
            .locator('[data-sidebar-entry="plugin:workboard/board-sessions"]')
            .getByRole("link", { name: "Team sessions", exact: true })
            .click();
          await gateway.waitForRequest("workboard.sessionsBoard.read");
          await page.locator(".workboard-page-title").hover();
          await page
            .getByRole("button", {
              name: locale === "fr" ? "Modifier le tableau" : "Edit board",
              exact: true,
            })
            .click();
          const form = page.locator(".workboard-board-draft");
          const column = form.locator('[data-column-id="working"]');
          await column.waitFor();
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
            const frame = await takeControlUiScreenshotFrame(page, form, [column], {
              animations: "disabled",
            });
            await writeFile(
              path.join(suite.artifactDir, `workboard-column-color-${locale}.png`),
              frame.png,
            );
          }
          expect(
            await column
              .getByRole("combobox", { name: locale === "fr" ? "Couleur" : "Color", exact: true })
              .count(),
          ).toBe(1);
          expect(await form.textContent()).not.toContain("workboard.boardColor");
          await form
            .getByRole("button", { name: locale === "fr" ? "Annuler" : "Cancel", exact: true })
            .waitFor();
          if (locale === "fr") {
            const name = form.locator(".workboard-board-draft__name input");
            await name.fill("Unsaved locale draft");
            // Exercise the real host locale owner while the compiled plugin remains mounted.
            await gateway.setMethodResponse(
              "config.get",
              configResponse({ locale: "en" }, "workboard-locale-en"),
            );
            await gateway.emitGatewayEvent("config.changed", { hash: "workboard-locale-en" });
            await form.getByRole("button", { name: "Cancel", exact: true }).waitFor();
            expect(await name.inputValue()).toBe("Unsaved locale draft");
            expect(await column.getByRole("combobox", { name: "Color", exact: true }).count()).toBe(
              1,
            );
          }
        },
      );
    },
  );
});
