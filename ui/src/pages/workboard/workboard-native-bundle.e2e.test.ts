import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import { webkit, type Browser, type Locator, type Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import {
  takeControlUiScreenshotFrame,
  waitForControlUiProofSurface,
} from "../../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiE2eWaitTimeoutMs,
  installMockGateway,
} from "../../test-helpers/control-ui-e2e.ts";
import { workboardUi } from "../../test-helpers/control-ui-workboard-fixture.ts";

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
const engines = ["chromium", "webkit"] as const;
const views = [
  { name: "desktop", viewport: { width: 1440, height: 1000 } },
  { name: "mobile", viewport: { width: 390, height: 844 } },
] as const;
const themes = ["light", "dark"] as const;
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const card: WorkboardCard = {
  id: "native-proof",
  title: "Review release readiness",
  notes: "Confirm the operator can inspect a task and return to the board.",
  labels: ["release"],
  status: "todo",
  priority: "normal",
  position: 1000,
  createdAt: 1_780_336_800_000,
  updatedAt: 1_780_336_800_000,
  agentId: "main",
  metadata: { automation: { boardId: "ops" } },
};
const board = {
  id: "ops",
  name: "Operations",
  total: 1,
  active: 1,
  archived: 0,
  byStatus: { todo: 1 },
};

async function capture(
  page: Page,
  engine: (typeof engines)[number],
  name: string,
  surface: Locator,
  content: Locator[],
) {
  if (!captureProof) {
    return;
  }
  const filename = path.join(suite.artifactDir, `${name}.png`);
  if (engine === "chromium") {
    const frame = await takeControlUiScreenshotFrame(page, surface, content, {
      animations: "disabled",
    });
    await writeFile(filename, frame.png);
  } else {
    // The shared frame encoder uses CDP; WebKit retains the same semantic readiness.
    await waitForControlUiProofSurface(surface, content);
    await page.screenshot({ path: filename, animations: "disabled" });
  }
}

suite.define(() => {
  it.each(engines)(
    "loads the native bundle and preserves overlay focus and card identity in %s",
    async (engine) => {
      for (const view of views) {
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
            const requestedAssets = new Set<string>();
            page.on("request", (request) => {
              if (request.url().includes("/__openclaw__/plugins/control-ui/workboard/")) {
                requestedAssets.add(request.url());
              }
            });
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
                "workboard.cards.list": {
                  boards: [board],
                  cards: [card],
                  statuses: ["todo", "done"],
                },
              },
            });
            await page.goto(`${suite.server.baseUrl}workboard/ops`);
            const tile = page.locator(".workboard-card").filter({ hasText: card.title });
            await tile.waitFor();
            expect((await gateway.waitForRequest("plugins.controlUi.report")).params).toMatchObject(
              {
                pluginId: "workboard",
                status: "activated",
              },
            );
            expect([...requestedAssets].some((url) => url.endsWith("/index.js"))).toBe(true);
            const prefix = `${engine}-${view.name}-${theme}`;
            const heading = page.locator(".workboard-page-title");
            await capture(page, engine, `${prefix}-board`, page.locator(".workboard-main"), [
              heading,
              tile,
            ]);

            const retained = await tile.elementHandle();
            if (!retained) {
              throw new Error("Native Workboard card did not mount");
            }
            try {
              await tile.focus();
              await gateway.setMethodResponse("workboard.cards.list", {
                boards: [board],
                cards: [{ ...card, labels: ["reviewed"], updatedAt: card.updatedAt + 1 }],
                statuses: ["todo", "done"],
              });
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
              expect(await tile.evaluate((element) => element === document.activeElement)).toBe(
                true,
              );

              await page.keyboard.press("Enter");
              const details = page.getByRole("dialog", { name: card.title, exact: true });
              const detailContent = page.locator(".workboard-detail");
              await details.waitFor();
              await expect
                .poll(() => details.evaluate((element) => element.matches(":focus-within")))
                .toBe(true);
              await capture(page, engine, `${prefix}-details`, details, [
                detailContent.getByRole("tab", { name: "Overview", exact: true }),
              ]);
              const actions = detailContent.getByRole("button", {
                name: "Card actions",
                exact: true,
              });
              await actions.click();
              const edit = detailContent.getByRole("button", { name: "Edit card", exact: true });
              await edit.waitFor();
              await edit.focus();
              await page.keyboard.press("Escape");
              expect(await details.isVisible()).toBe(true);
              await expect.poll(() => actions.getAttribute("aria-expanded")).toBe("false");
              expect(await actions.evaluate((element) => element === document.activeElement)).toBe(
                true,
              );
              await page.keyboard.press("Escape");
              await details.waitFor({ state: "detached" });
              await expect
                .poll(() => tile.evaluate((element) => element === document.activeElement))
                .toBe(true);
            } finally {
              await retained.dispose();
            }

            const create = page
              .locator(".workboard-heading__actions")
              .getByRole("button", { name: "New card", exact: true });
            await create.focus();
            await page.keyboard.press("Enter");
            const modal = page.getByRole("dialog", { name: "New card", exact: true });
            const title = page
              .locator(".workboard-card-draft")
              .getByLabel("Title", { exact: true });
            await title.waitFor();
            await expect
              .poll(() => title.evaluate((element) => element === document.activeElement))
              .toBe(true);
            await capture(page, engine, `${prefix}-create`, modal, [title]);
            await page.keyboard.press("Escape");
            await modal.waitFor({ state: "detached" });
            await expect
              .poll(() => create.evaluate((element) => element === document.activeElement))
              .toBe(true);
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
