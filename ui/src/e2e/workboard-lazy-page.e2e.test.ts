import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { workboardUi } from "../test-helpers/control-ui-workboard-fixture.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Compiled Workboard page loading",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it.each(["success", "network failure"] as const)(
    "loads the compiled page with %s and preserves its board controls and styles",
    async (outcome) => {
      await suite.withPage(
        { viewport: { width: 1280, height: 900 }, serviceWorkers: "block" },
        async ({ page }) => {
          const boards = [
            {
              id: "ops",
              name: "Operations",
              total: 1,
              active: 1,
              archived: 0,
              byStatus: { ready: 1 },
            },
          ];
          const cards = [
            {
              id: "ops-ready",
              title: "Review release",
              status: "ready",
              priority: "normal",
              labels: [],
              position: 1_000,
              createdAt: 1,
              updatedAt: 2,
              agentId: "main",
              metadata: { automation: { boardId: "ops" } },
            },
          ];
          await installMockGateway(page, {
            ...workboardUi,
            methodResponses: {
              "workboard.boards.list": { boards },
              "workboard.cards.list": { boards, cards, statuses: ["ready", "done"] },
            },
          });
          await page.addInitScript(
            (key) =>
              localStorage.setItem(
                key,
                JSON.stringify({
                  sidebarEntries: ["route:agents-home", "plugin:workboard/board-ops"],
                }),
              ),
            controlUiBundledSettingsStorageKey(suite.server.baseUrl),
          );
          const requested = new Set<string>();
          page.on("request", (request) => {
            if (request.url().includes("/__openclaw__/plugins/control-ui/workboard/")) {
              requested.add(request.url());
            }
          });
          await page.goto(`${suite.server.baseUrl}new`);
          const navigation = page.locator('[data-sidebar-entry="plugin:workboard/board-ops"]');
          await navigation.getByRole("link", { name: "Operations", exact: true }).waitFor();
          const eager = new Set(requested);
          expect([...eager].some((url) => url.endsWith("/index.js"))).toBe(true);
          expect([...eager].some((url) => url.endsWith("/index.css"))).toBe(true);
          const gate = createDeferred();
          const chunks = /\/__openclaw__\/plugins\/control-ui\/workboard\/[^/]+\/chunk-[^/]+\.js$/u;
          await page.route(chunks, async (route) => {
            await gate.promise;
            if (outcome === "network failure") {
              await route.abort("failed");
            } else {
              await route.fallback();
            }
          });
          try {
            const [chunkRequest] = await Promise.all([
              page.waitForRequest(chunks),
              navigation.getByRole("link", { name: "Operations", exact: true }).click(),
            ]);
            expect(eager.has(chunkRequest.url())).toBe(false);
            await page.getByRole("status").filter({ hasText: "Loading Workboard…" }).waitFor();
            gate.resolve();
            if (outcome === "network failure") {
              await page
                .getByRole("alert")
                .filter({ hasText: "Check your connection and reload this page." })
                .waitFor();
              await page.unroute(chunks);
              await page.reload();
            }
            const title = page.locator(".workboard-page-title", { hasText: "Operations" });
            await title.waitFor();
            await page.getByRole("button", { name: "New board", exact: true }).waitFor();
            const board = page.locator(".workboard-board--page");
            await board.waitFor();
            expect(await board.evaluate((element) => getComputedStyle(element).display)).toBe(
              "flex",
            );
            expect(
              await page.getByRole("status").filter({ hasText: "Loading Workboard…" }).count(),
            ).toBe(0);
            if (outcome === "success" && process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
              const frame = await takeControlUiScreenshotFrame(page, board, [title], {
                animations: "disabled",
              });
              await writeFile(
                path.join(suite.artifactDir, "compiled-workboard-page.png"),
                frame.png,
              );
            }
          } finally {
            gate.resolve();
            await page.unroute(chunks);
          }
        },
      );
    },
  );
});
