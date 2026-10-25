import type { WorkboardCard } from "@openclaw/workboard-contract";
import { webkit, type Browser, type Locator } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiE2eWaitTimeoutMs,
  installMockGateway,
} from "../../test-helpers/control-ui-e2e.ts";
import { workboardUi } from "../../test-helpers/control-ui-workboard-fixture.ts";
import { createWorkboardProof, button, makeBoard, makeCard } from "./workboard.e2e.test-support.ts";

let webkitBrowser: Browser | undefined;
const suite = createControlUiE2eSuite({
  name: "Workboard native bundle overlay parity",
  startServerBeforeBrowser: true,
  resources: {
    async run() {
      webkitBrowser = await webkit.launch();
    },
    async close() {
      await webkitBrowser?.close();
    },
  },
});
const views = [
  { name: "desktop", viewport: { width: 1440, height: 1000 } },
  { name: "mobile", viewport: { width: 390, height: 844 } },
] as const;
const card = makeCard({
  id: "native-proof",
  title: "Review release readiness",
  labels: ["release"],
  metadata: { automation: { boardId: "ops" } },
});
const secondCard = makeCard({
  id: "second-native-proof",
  title: "Prepare release checklist",
  position: 2000,
  metadata: { automation: { boardId: "ops" } },
});
const board = makeBoard("ops", { name: "Operations", total: 2, active: 2, byStatus: { todo: 2 } });

const cardsResponse = (cards: WorkboardCard[]) => ({
  boards: [board],
  cards,
  statuses: ["todo", "done"],
});

async function expectNativeFocus(locator: Locator, description: string, checkWithin = false) {
  await expect
    .poll(async () => {
      const observation = await locator.evaluate(
        (element, { context, within }) => ({
          context,
          focused: within ? element.matches(":focus-within") : element === document.activeElement,
          expectedTag: element.tagName,
          expectedLabel: element.getAttribute("aria-label"),
          activeTag: document.activeElement?.tagName,
          activeLabel: document.activeElement?.getAttribute("aria-label"),
          activeClass: document.activeElement?.className,
          activeText: document.activeElement?.textContent?.trim().slice(0, 160),
        }),
        { context: description, within: checkWithin },
      );
      return observation.focused ? "focused" : JSON.stringify(observation);
    })
    .toBe("focused");
}

suite.define(() => {
  it.each(["chromium", "webkit"] as const)(
    "loads the native bundle and preserves overlay focus and card identity in %s",
    async (engine) => {
      const proof = createWorkboardProof(suite, "workboard-native", undefined, {
        captureMode: engine,
      });
      for (const view of views) {
        for (const theme of ["light", "dark"] as const) {
          const options = {
            colorScheme: theme,
            locale: "en-US",
            reducedMotion: "reduce" as const,
            serviceWorkers: "block" as const,
            viewport: view.viewport,
          };
          const context =
            engine === "chromium"
              ? await suite.newBrowserContext(options)
              : await webkitBrowser!.newContext(options);
          try {
            const page = await context.newPage();
            page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
            const errors: string[] = [];
            page.on("pageerror", (error) => errors.push(error.message));
            await page.addInitScript(
              ({ key, theme: colorTheme }) => {
                localStorage.setItem("openclaw.i18n.locale", "en");
                localStorage.setItem(key, JSON.stringify({ theme: colorTheme }));
              },
              { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl), theme },
            );
            const gateway = await installMockGateway(page, {
              ...workboardUi,
              methodResponses: {
                "workboard.boards.list": { boards: [board] },
                "workboard.cards.list": cardsResponse([card, secondCard]),
              },
            });
            await page.goto(`${suite.server.baseUrl}workboard/ops`);
            const tile = page.locator(".workboard-card").filter({ hasText: card.title });
            await tile.waitFor();
            const prefix = `${engine}-${view.name}-${theme}`;
            const expectFocus = (target: Locator, action: string, within = false) =>
              expectNativeFocus(target, `${prefix}: ${action}`, within);
            await proof.capture(page, `${prefix}-board`, page.locator(".workboard-main"), [
              page.locator(".workboard-page-title"),
              tile,
            ]);

            const retained = expectDefined(await tile.elementHandle(), "Native Workboard card");
            await tile.focus();
            await gateway.setMethodResponse(
              "workboard.cards.list",
              cardsResponse([
                { ...card, labels: ["reviewed"], updatedAt: card.updatedAt + 1 },
                secondCard,
              ]),
            );
            await gateway.emitGatewayEvent("plugin.workboard.changed", {
              epoch: "native-proof",
              revision: 1,
            });
            await tile.getByText("reviewed", { exact: true }).waitFor();
            expect(
              await retained.evaluate(
                (element) => element === document.querySelector(".workboard-card"),
              ),
            ).toBe(true);
            await expectFocus(tile, "retained card after live update");

            const rowActions = button(tile, "Card actions");
            const rowMenu = page.locator(".workboard-main > .workboard-card__action-menu-panel");
            const retainedMenu = expectDefined(await rowMenu.elementHandle(), "Shared card menu");
            await rowActions.click();
            await rowMenu.waitFor({ state: "visible" });
            await expectFocus(button(rowMenu, "View details"), "pointer-open menu entry");
            const traversalKey =
              engine === "webkit" && process.platform === "darwin" ? "Alt+Tab" : "Tab";
            await page.keyboard.press(traversalKey);
            await expectFocus(
              button(rowMenu, "Edit card"),
              `menu traversal from View details (${process.platform}, ${traversalKey})`,
            );
            expect(await rowActions.evaluate((element) => getComputedStyle(element).opacity)).toBe(
              "1",
            );

            const secondTile = page
              .locator(".workboard-card")
              .filter({ hasText: secondCard.title });
            const secondActions = button(secondTile, "Card actions");
            await secondActions.focus();
            await secondActions.press("Enter");
            await rowMenu.waitFor({ state: "visible" });
            await expect
              .poll(() => rowMenu.getByRole("combobox").getAttribute("aria-label"))
              .toBe(`Status: ${secondCard.title}`);
            await expectFocus(button(rowMenu, "View details"), "second-card menu entry");
            expect(
              await retainedMenu.evaluate(
                (element) => element.parentElement === document.querySelector(".workboard-main"),
              ),
            ).toBe(true);

            await rowActions.focus();
            await rowActions.press("Enter");
            await rowMenu.waitFor({ state: "visible" });
            await expectFocus(
              button(rowMenu, "View details"),
              "first-card menu entry after switch",
            );
            await rowActions.click();
            await rowMenu.waitFor({ state: "hidden" });
            // Pointer focus follows the platform; keyboard toggles retain the trigger.
            await rowActions.focus();
            await rowActions.press("Enter");
            await rowMenu.waitFor({ state: "visible" });
            await expectFocus(button(rowMenu, "View details"), "Enter-opened menu entry");
            await rowActions.focus();
            await rowActions.press("Enter");
            await rowMenu.waitFor({ state: "hidden" });
            await expectFocus(rowActions, "same-trigger keyboard menu close");
            await rowActions.press("Enter");
            await rowMenu.waitFor({ state: "visible" });
            await expectFocus(button(rowMenu, "View details"), "Enter-reopened menu entry");
            await button(rowMenu, "Edit card").focus();
            await page.keyboard.press("Escape");
            await rowMenu.waitFor({ state: "hidden" });
            await expectFocus(rowActions, "menu Escape return");

            await tile.focus();
            await page.keyboard.press("Enter");
            const details = page.getByRole("dialog", { name: card.title, exact: true });
            const detailContent = page.locator(".workboard-detail");
            await details.waitFor();
            expect(await rowMenu.evaluate((element) => element.matches(":popover-open"))).toBe(
              false,
            );
            expect(await rowMenu.evaluate((element) => element.closest("[inert]") !== null)).toBe(
              true,
            );
            await expectFocus(details, "card details entry", true);
            await proof.capture(page, `${prefix}-details`, details, [
              detailContent.getByRole("tab", { name: "Overview", exact: true }),
            ]);
            const actions = button(detailContent, "Card actions");
            await actions.click();
            await button(detailContent, "Edit card").focus();
            await page.keyboard.press("Escape");
            expect(await details.isVisible()).toBe(true);
            await expect.poll(() => actions.getAttribute("aria-expanded")).toBe("false");
            await expectFocus(actions, "nested details menu Escape return");
            await page.keyboard.press("Escape");
            await details.waitFor({ state: "detached" });
            await expectFocus(tile, "card details Escape return");

            const create = button(page.locator(".workboard-heading__actions"), "New card");
            await create.focus();
            await page.keyboard.press("Enter");
            const modal = page.getByRole("dialog", { name: "New card", exact: true });
            const title = modal.getByLabel("Title", { exact: true });
            await title.waitFor();
            expect(await rowMenu.evaluate((element) => element.matches(":popover-open"))).toBe(
              false,
            );
            expect(await rowMenu.evaluate((element) => element.closest("[inert]") !== null)).toBe(
              true,
            );
            await expectFocus(title, "new-card dialog entry");
            await proof.capture(page, `${prefix}-create`, modal, [title]);
            await page.keyboard.press("Escape");
            await modal.waitFor({ state: "detached" });
            await expectFocus(create, "new-card dialog Escape return");
            expect(await gateway.getRequests("workboard.cards.create")).toEqual([]);
            expect(errors).toEqual([]);
          } finally {
            if (engine === "chromium") {
              await suite.closeBrowserContext(context);
            } else {
              await context.close();
            }
          }
        }
      }
    },
    120_000,
  );
});
import { expectDefined } from "@openclaw/normalization-core";
