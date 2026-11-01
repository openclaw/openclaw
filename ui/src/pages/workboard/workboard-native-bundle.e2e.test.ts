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
      const proof = createWorkboardProof("workboard-native", {
        captureMode: engine,
      });
      for (const view of views) {
        // Native behavior covers both layouts; visual proof keeps every theme/layout pair.
        const themes =
          process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
            ? (["light", "dark"] as const)
            : ([view.name === "desktop" ? "light" : "dark"] as const);
        for (const theme of themes) {
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
  it.each(["chromium", "webkit"] as const)(
    "preserves native focus, scrolling, and same-column drops in a large column in %s",
    async (engine) => {
      const windowContextOptions = {
        colorScheme: "light" as const,
        locale: "en-US",
        reducedMotion: "reduce" as const,
        serviceWorkers: "block" as const,
        viewport: { width: 1440, height: 1100 },
      };
      const windowContext =
        engine === "chromium"
          ? await suite.newBrowserContext(windowContextOptions)
          : await webkitBrowser!.newContext(windowContextOptions);
      try {
        const page = await windowContext.newPage();
        page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.addInitScript(
          ({ key }) => {
            localStorage.setItem("openclaw.i18n.locale", "en");
            localStorage.setItem(key, JSON.stringify({ theme: "light" }));
          },
          { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl) },
        );
        let windowCards = Array.from({ length: 60 }, (_, index) =>
          makeCard({
            id: `window-${index}`,
            title: `Window card ${String(index).padStart(2, "0")}`,
            position: (index + 1) * 1000,
            metadata: { automation: { boardId: "ops" } },
          }),
        );
        const windowBoard = makeBoard("ops", {
          name: "Operations",
          total: 60,
          active: 60,
          byStatus: { todo: 60 },
        });
        const windowResponse = () => ({
          boards: [windowBoard],
          cards: windowCards.toSorted((left, right) => left.position - right.position),
          statuses: ["todo"],
        });
        const gateway = await installMockGateway(page, {
          ...workboardUi,
          methodResponses: {
            "workboard.boards.list": { boards: [windowBoard] },
            "workboard.cards.list": windowResponse(),
          },
        });
        await page.goto(`${suite.server.baseUrl}workboard/ops`);
        const column = page.locator(".workboard-column--todo");
        const viewport = column.locator(".workboard-column__cards");
        const windowCard = (id: string) =>
          column.locator(`.workboard-column__item[data-card-id="${id}"] .workboard-card`);
        const settleWindow = () =>
          page.evaluate(
            () =>
              new Promise<void>((resolve) => {
                requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
              }),
          );
        const fitsColumn = (target: Locator) =>
          target.evaluate((element) => {
            const scrollport = element.closest(".workboard-column__cards")!;
            const bounds = element.getBoundingClientRect();
            const visible = scrollport.getBoundingClientRect();
            return bounds.top >= visible.top && bounds.bottom <= visible.bottom;
          });
        const revealWindowCard = async (id: string) => {
          const target = windowCard(id);
          await viewport.evaluate((element) => {
            element.scrollTop = 0;
          });
          await settleWindow();
          for (let attempt = 0; attempt < 60 && (await target.count()) === 0; attempt++) {
            const advanced = await viewport.evaluate((element) => {
              const previousTop = element.scrollTop;
              element.scrollTop += element.clientHeight * 0.8;
              return element.scrollTop > previousTop;
            });
            await settleWindow();
            if (!advanced) {
              break;
            }
          }
          await target.waitFor();
          await target.evaluate((element) => element.scrollIntoView({ block: "center" }));
          await settleWindow();
          await expect.poll(() => fitsColumn(target)).toBe(true);
          return target;
        };
        await windowCard("window-0").waitFor();
        expect(await column.getAttribute("aria-label")).toBe("Todo, 60");
        expect(await column.locator(".workboard-card").count()).toBeLessThan(60);
        expect(await windowCard("window-30").count()).toBe(0);
        const toolbar = page.locator(".workboard-toolbar");
        const toolbarTop = await toolbar.evaluate((element) => element.getBoundingClientRect().top);
        await revealWindowCard("window-30");
        expect(await viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        await revealWindowCard("window-59");
        expect(
          await toolbar.evaluate((element) => element.getBoundingClientRect().top),
        ).toBeCloseTo(toolbarTop, 0);

        const settleMeasurements = async () => {
          // Let real resize and scroll events settle before comparing visual positions.
          for (let frame = 0; frame < 8; frame++) {
            await settleWindow();
          }
        };
        const lastCardOffset = () =>
          windowCard("window-59").evaluate((element) => {
            const scrollport = element.closest(".workboard-column__cards")!;
            return element.getBoundingClientRect().top - scrollport.getBoundingClientRect().top;
          });
        await settleMeasurements();
        await viewport.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        await settleMeasurements();
        const bottomOffset = await lastCardOffset();
        // The pinned first card can resize while offscreen without losing the visible bottom card.
        await windowCard("window-0").evaluate((element) => {
          element.style.minHeight = "1000px";
        });
        await settleMeasurements();
        expect(Math.abs((await lastCardOffset()) - bottomOffset)).toBeLessThanOrEqual(1);
        await windowCard("window-0").evaluate((element) => {
          element.style.minHeight = "";
        });
        await settleMeasurements();
        expect(Math.abs((await lastCardOffset()) - bottomOffset)).toBeLessThanOrEqual(1);

        await revealWindowCard("window-30");
        const mountedIds = new Set(
          await column
            .locator(".workboard-column__item")
            .evaluateAll((elements) =>
              elements.map((element) => element.getAttribute("data-card-id")),
            ),
        );
        const edge = windowCards.findLastIndex(
          (candidate, index) =>
            index + 1 < windowCards.length &&
            mountedIds.has(candidate.id) &&
            !mountedIds.has(windowCards[index + 1]!.id),
        );
        expect(
          edge,
          "middle window must have an initially unmounted next logical card",
        ).toBeGreaterThanOrEqual(0);
        const fromCard = windowCard(windowCards[edge]!.id);
        const nextCard = windowCard(windowCards[edge + 1]!.id);
        expect(await nextCard.count()).toBe(0);
        await fromCard.focus();
        const forwardKey = engine === "webkit" && process.platform === "darwin" ? "Alt+Tab" : "Tab";
        const reverseKey =
          engine === "webkit" && process.platform === "darwin" ? "Alt+Shift+Tab" : "Shift+Tab";
        for (let step = 0; step < 16; step++) {
          await page.keyboard.press(forwardKey);
          if (
            (await nextCard.count()) &&
            (await nextCard.evaluate((element) => element === document.activeElement))
          ) {
            break;
          }
        }
        await expectNativeFocus(nextCard, `${engine}: window edge forward (${forwardKey})`);
        for (let step = 0; step < 16; step++) {
          await page.keyboard.press(reverseKey);
          if (await fromCard.evaluate((element) => element === document.activeElement)) {
            break;
          }
        }
        await expectNativeFocus(fromCard, `${engine}: window edge reverse (${reverseKey})`);

        const returnCard = await revealWindowCard("window-30");
        const retainedCard = expectDefined(
          await returnCard.elementHandle(),
          "Windowed return-focus card",
        );
        try {
          await returnCard.focus();
          await returnCard.press("Enter");
          const details = page.getByRole("dialog", { name: "Window card 30", exact: true });
          await details.waitFor();
          await expectNativeFocus(details, `${engine}: windowed card dialog entry`, true);
          await viewport.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
          });
          await settleWindow();
          expect(await fitsColumn(returnCard)).toBe(false);
          await page.keyboard.press("Escape");
          await details.waitFor({ state: "detached" });
          await expectNativeFocus(returnCard, `${engine}: scrolled window dialog return`);
          expect(
            await returnCard.evaluate((element, original) => element === original, retainedCard),
          ).toBe(true);
        } finally {
          await retainedCard.dispose();
        }

        // Reachable same-column gaps exercise logical order; this does not test edge autoscroll.
        for (const drop of [
          { source: "window-27", after: "window-29", before: "window-30", position: 30500 },
          { source: "window-57", after: "window-59", before: null, position: 61000 },
        ]) {
          const targetCard = await revealWindowCard(drop.after);
          await targetCard.evaluate((element) => element.scrollIntoView({ block: "end" }));
          await settleWindow();
          const sourceCard = windowCard(drop.source);
          await sourceCard.waitFor();
          await expect.poll(() => fitsColumn(sourceCard)).toBe(true);
          await expect.poll(() => fitsColumn(targetCard)).toBe(true);
          const updatedCard = {
            ...expectDefined(
              windowCards.find((candidate) => candidate.id === drop.source),
              drop.source,
            ),
            position: drop.position,
          };
          windowCards = windowCards.map((candidate) =>
            candidate.id === drop.source ? updatedCard : candidate,
          );
          await gateway.setMethodResponse("workboard.cards.move", { card: updatedCard });
          await gateway.setMethodResponse("workboard.cards.list", windowResponse());
          const beforeMoves = (await gateway.getRequests("workboard.cards.move")).length;
          const targetPosition = await targetCard.evaluate((element) => {
            const scrollport = element.closest(".workboard-column__cards")!;
            const bounds = element.getBoundingClientRect();
            const visible = scrollport.getBoundingClientRect();
            return { x: visible.width / 2, y: bounds.bottom - visible.top + 6 };
          });
          // Both endpoints are visible; scrolling the target rect can move the source under the pointer.
          await sourceCard.dragTo(viewport, { targetPosition, scroll: "none" });
          const request = await gateway.waitForRequest("workboard.cards.move", {
            after: beforeMoves,
          });
          expect(request.params).toMatchObject({
            id: drop.source,
            status: "todo",
            position: drop.position,
          });
          // Reordering can move the source out of the current rendered window.
          await revealWindowCard(drop.source);
          await expect
            .poll(async () => {
              const orderedIds = await column
                .locator(".workboard-column__item")
                .evaluateAll((elements) =>
                  elements.map((element) => element.getAttribute("data-card-id")),
                );
              const sourceIndex = orderedIds.indexOf(drop.source);
              const afterIndex = orderedIds.indexOf(drop.after);
              return (
                afterIndex >= 0 &&
                sourceIndex > afterIndex &&
                (drop.before === null
                  ? sourceIndex === orderedIds.length - 1
                  : orderedIds.indexOf(drop.before) > sourceIndex)
              );
            })
            .toBe(true);
        }
        await settleMeasurements();
        await viewport.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        await settleMeasurements();
        const finalCardOffset = () =>
          windowCard("window-57").evaluate((element) => {
            const scrollport = element.closest(".workboard-column__cards")!;
            return element.getBoundingClientRect().top - scrollport.getBoundingClientRect().top;
          });
        const beforeRemovalOffset = await finalCardOffset();
        windowCards = windowCards.filter((candidate) => candidate.id !== "window-0");
        const removedBoard = {
          ...windowBoard,
          total: windowCards.length,
          active: windowCards.length,
          byStatus: { todo: windowCards.length },
        };
        await gateway.setMethodResponse("workboard.boards.list", { boards: [removedBoard] });
        await gateway.setMethodResponse("workboard.cards.list", {
          ...windowResponse(),
          boards: [removedBoard],
        });
        await gateway.emitGatewayEvent("plugin.workboard.changed", {
          epoch: "native-window-removal",
          revision: 1,
        });
        await expect.poll(() => column.getAttribute("aria-label")).toBe("Todo, 59");
        await settleMeasurements();
        expect(
          await column.locator(".workboard-column__item").last().getAttribute("data-card-id"),
        ).toBe("window-57");
        const afterRemovalOffset = await finalCardOffset();
        expect(
          Math.abs(afterRemovalOffset - beforeRemovalOffset),
          `Last-card offset before ${beforeRemovalOffset}, after removal ${afterRemovalOffset}`,
        ).toBeLessThanOrEqual(1);
        expect(errors).toEqual([]);
      } finally {
        if (engine === "chromium") {
          await suite.closeBrowserContext(windowContext);
        } else {
          await windowContext.close();
        }
      }
    },
    120_000,
  );
});
import { expectDefined } from "@openclaw/normalization-core";
