import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Catalog partial warning",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

async function expandCodingSection(page: Page) {
  const toggle = page.locator('[data-session-section="work"] .sidebar-session-group-toggle');
  await page.waitForFunction(() =>
    Boolean(
      document.querySelector('[data-session-section="work"]') ??
      document.querySelector('[data-session-section^="catalog:"]'),
    ),
  );
  if ((await toggle.count()) > 0 && (await toggle.getAttribute("aria-expanded")) === "false") {
    await toggle.click();
  }
}

suite.define(() => {
  it("retains a partial-page warning after appending a clean catalog page", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      await page.addInitScript(() => {
        localStorage.setItem("openclaw.i18n.locale", "en");
      });
      const catalogPage = (
        sessions: Array<{ threadId: string; name: string }>,
        nextCursor?: string,
        error?: { code: string; message: string },
      ) => ({
        catalogs: [
          {
            id: "claude",
            label: "Claude Code",
            capabilities: { continueSession: true, archive: false },
            hosts: [
              {
                hostId: "gateway:local",
                label: "Local Mac",
                kind: "local",
                connected: true,
                sessions,
                ...(nextCursor ? { nextCursor } : {}),
                ...(error ? { error } : {}),
              },
            ],
          },
        ],
      });
      const gateway = await installMockGateway(page, {
        featureMethods: ["chat.metadata", "chat.startup", "sessions.catalog.list"],
        methodResponses: {
          "sessions.catalog.list": {
            cases: [
              {
                match: { cursors: { "gateway:local": "page-2" } },
                response: catalogPage([{ threadId: "thread-2", name: "Older" }], "page-3", {
                  code: "LOCAL_CATALOG_PARTIAL",
                  message: "One metadata file was skipped",
                }),
              },
              {
                match: { cursors: { "gateway:local": "page-3" } },
                response: catalogPage([{ threadId: "thread-3", name: "Oldest" }]),
              },
              {
                match: {},
                response: catalogPage([{ threadId: "thread-1", name: "Newest" }], "page-2"),
              },
            ],
          },
        },
      });
      const artifactRoot = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
      const artifactDir = artifactRoot
        ? createControlUiE2eArtifactDir("catalog-partial-warning", artifactRoot)
        : undefined;

      await page.goto(`${suite.server.baseUrl}chat`);
      await expandCodingSection(page);
      await expect.poll(() => page.locator("body").textContent()).toContain("Home");
      const section = page.locator('[data-session-section="catalog:claude"]');
      const loadMore = page.locator('[data-session-catalog-load-more="claude"]');
      await section.getByText("Newest", { exact: true }).waitFor();
      await expect.poll(() => gateway.getRequests("sessions.catalog.list")).toHaveLength(1);
      expect(await section.locator('[data-session-catalog-error="claude"]').count()).toBe(0);
      if (artifactDir) {
        await page.screenshot({
          path: path.join(artifactDir, "01-before-pagination.png"),
          fullPage: true,
        });
      }

      await loadMore.click();
      await section.getByText("Older", { exact: true }).waitFor();
      await section.locator('[data-session-catalog-error="claude"]').waitFor();
      expect(await section.getByText("Newest", { exact: true }).count()).toBe(1);
      expect(await loadMore.isVisible()).toBe(true);
      if (artifactDir) {
        await page.screenshot({
          path: path.join(artifactDir, "02-after-partial-page.png"),
          fullPage: true,
        });
      }

      await loadMore.click();
      await section.getByText("Oldest", { exact: true }).waitFor();
      await expect
        .poll(() => section.locator('[data-session-catalog-error="claude"]').count())
        .toBe(1);
      expect(await section.getByText("Newest", { exact: true }).count()).toBe(1);
      expect(await section.getByText("Older", { exact: true }).count()).toBe(1);
      expect(await loadMore.count()).toBe(0);
      if (artifactDir) {
        await page.screenshot({
          path: path.join(artifactDir, "03-after-clean-page-warning-retained.png"),
          fullPage: true,
        });
        await writeFile(
          path.join(artifactDir, "catalog-partial-warning-transcript.json"),
          JSON.stringify(
            {
              entrypoint: "Control UI → Claude Code catalog → Load more",
              locale: "en",
              before: { sessions: ["Newest"], warning: false, hasMore: true },
              partialPage: {
                sessions: ["Newest", "Older"],
                warning: "One metadata file was skipped",
                hasMore: true,
              },
              cleanPage: {
                sessions: ["Newest", "Older", "Oldest"],
                warning: "One metadata file was skipped",
                hasMore: false,
              },
              gateway: "isolated in-browser fixture",
            },
            null,
            2,
          ),
        );
      }
    });
  });
});
