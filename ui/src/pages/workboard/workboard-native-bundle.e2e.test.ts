import type { WorkboardCard } from "@openclaw/workboard-contract";
import { webkit, type Browser } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiE2eWaitTimeoutMs,
  installMockGateway,
} from "../../test-helpers/control-ui-e2e.ts";
import { workboardUi } from "../../test-helpers/control-ui-workboard-fixture.ts";
import {
  createWorkboardProof,
  button,
  expectFocus,
  focused,
  makeBoard,
  makeCard,
} from "./workboard.e2e.test-support.ts";

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
const board = makeBoard("ops", { name: "Operations", total: 1, active: 1, byStatus: { todo: 1 } });

const cardsResponse = (cards: WorkboardCard[]) => ({
  boards: [board],
  cards,
  statuses: ["todo", "done"],
});

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
                "workboard.cards.list": cardsResponse([card]),
              },
            });
            await page.goto(`${suite.server.baseUrl}workboard/ops`);
            const tile = page.locator(".workboard-card").filter({ hasText: card.title });
            await tile.waitFor();
            const prefix = `${engine}-${view.name}-${theme}`;
            await proof.capture(page, `${prefix}-board`, page.locator(".workboard-main"), [
              page.locator(".workboard-page-title"),
              tile,
            ]);

            const retained = expectDefined(await tile.elementHandle(), "Native Workboard card");
            await tile.focus();
            await gateway.setMethodResponse(
              "workboard.cards.list",
              cardsResponse([{ ...card, labels: ["reviewed"], updatedAt: card.updatedAt + 1 }]),
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
            expect(await focused(tile)).toBe(true);

            await page.keyboard.press("Enter");
            const details = page.getByRole("dialog", { name: card.title, exact: true });
            const detailContent = page.locator(".workboard-detail");
            await details.waitFor();
            await expectFocus(details, true);
            await proof.capture(page, `${prefix}-details`, details, [
              detailContent.getByRole("tab", { name: "Overview", exact: true }),
            ]);
            const actions = button(detailContent, "Card actions");
            await actions.click();
            await button(detailContent, "Edit card").focus();
            await page.keyboard.press("Escape");
            expect(await details.isVisible()).toBe(true);
            await expect.poll(() => actions.getAttribute("aria-expanded")).toBe("false");
            expect(await focused(actions)).toBe(true);
            await page.keyboard.press("Escape");
            await details.waitFor({ state: "detached" });
            await expectFocus(tile);

            const create = button(page.locator(".workboard-heading__actions"), "New card");
            await create.focus();
            await page.keyboard.press("Enter");
            const modal = page.getByRole("dialog", { name: "New card", exact: true });
            const title = modal.getByLabel("Title", { exact: true });
            await title.waitFor();
            await expectFocus(title);
            await proof.capture(page, `${prefix}-create`, modal, [title]);
            await page.keyboard.press("Escape");
            await modal.waitFor({ state: "detached" });
            await expectFocus(create);
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
