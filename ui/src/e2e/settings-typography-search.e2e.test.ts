import path from "node:path";
import { expect } from "playwright/test";
import { it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  installMockGateway,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Settings typography search" });

suite.define(() => {
  it.each([
    { query: "Language", destination: "Language" },
    { query: "Text size", destination: "Text size" },
    { query: "Typography", destination: "Typography" },
    { query: "font", destination: "Typography" },
    { query: "Chat prose", destination: "Typography" },
  ])(
    "finds the visible $destination controls by searching $query",
    async ({ query, destination }) => {
      await suite.withPage(
        { locale: "en-US", viewport: { width: 1280, height: 1000 } },
        async ({ page }) => {
          const artifacts = createControlUiE2eArtifactDir("settings-typography-search");
          const gateway = await installMockGateway(page);
          await page.goto(`${suite.server.baseUrl}settings/appearance`);
          const { sidebar, search } = await waitForControlUiSettingsTakeover(page);
          await sidebar.getByRole("link", { name: "Gateway", exact: true }).click();
          await expect(page).toHaveURL(/\/settings\/connection$/);
          await sidebar.getByRole("link", { name: "Appearance", exact: true }).click();
          await expect(page).toHaveURL(/\/settings\/appearance$/);
          const typography = page.getByRole("heading", { name: "Typography", exact: true });
          await typography.scrollIntoViewIfNeeded();
          await expect(typography).toBeInViewport();
          const typographySection = page.locator(".settings-section").filter({ has: typography });
          await expect(typographySection.getByText("Interface", { exact: true })).toBeVisible();
          await expect(typographySection.getByText("Chat prose", { exact: true })).toBeVisible();
          await typographySection.scrollIntoViewIfNeeded();
          await page.screenshot({ path: path.join(artifacts, "typography-present.png") });

          await page.locator(".page-title").scrollIntoViewIfNeeded();
          await search.fill(query);
          await expect(search).toHaveValue(query);
          await page.screenshot({ path: path.join(artifacts, "search-before-result.png") });
          const result = sidebar.getByRole("link", { name: destination, exact: true });
          await expect(result).toBeVisible();
          await result.click();
          await expect(page).toHaveURL(/\/settings\/appearance\?/);
          const heading = page.getByRole("heading", { name: destination, exact: true });
          await expect(heading).toBeInViewport();
          await expect.poll(async () => (await heading.boundingBox())?.y).toBeLessThan(500);
          await page.screenshot({ path: path.join(artifacts, "search-destination.png") });
          expect(await gateway.getRequests("config.set")).toHaveLength(0);
          expect(await gateway.getRequests("config.patch")).toHaveLength(0);
        },
      );
    },
  );
});
