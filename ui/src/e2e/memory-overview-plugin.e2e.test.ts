import { expect } from "playwright/test";
import { it } from "vitest";
import { sourceConfigSnapshot } from "../lib/config/config-snapshot.test-support.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Packaged Memory overview" });
const pageOptions = {
  viewport: { width: 1440, height: 1000 },
  locale: "en-US",
  reducedMotion: "reduce",
} as const;
function memoryFixture(config: Record<string, unknown>, hash: string) {
  return {
    "config.get": sourceConfigSnapshot(config, hash),
    "plugins.list": { plugins: [], diagnostics: [], mutationAllowed: true },
    "plugins.controlUi.list": { plugins: [], diagnostics: [], revision: "empty" },
    "doctor.memory.status": {
      agentId: "main",
      provider: "local",
      embedding: { ok: false, checked: false },
    },
  };
}
suite.define(() => {
  it("keeps tab spacing, compact result paths, and the selected Memory file", async () => {
    const width = 390,
      height = 844;
    await suite.withPage(
      { ...pageOptions, viewport: { width, height }, isMobile: width < 900, hasTouch: true },
      async ({ page }) => {
        const memoryPath =
          "memory/release-readiness/customer-support-handoff/documentation_review_for_the_responsive_release_checklist_approved.md";
        const gw = await installMockGateway(page, {
          communityInvite: false,
          featureMethods: [...defaultControlUiFeatureMethods, "memory.search"],
          methodResponses: {
            ...memoryFixture({}, "phone-memory"),
            "memory.search": {
              searchMode: "hybrid",
              results: [
                {
                  path: "MEMORY.md",
                  startLine: 1,
                  endLine: 1,
                  score: 0.96,
                  source: "memory",
                  snippet: "The field guide has a new owner.",
                },
                {
                  path: memoryPath,
                  startLine: 2,
                  endLine: 2,
                  score: 0.88,
                  source: "memory",
                  snippet: "The release notes are ready for the next handoff.",
                },
              ],
            },
            "agents.workspace.get": {
              file: {
                encoding: "utf8",
                content: "Introduction\nVerified handoff record\nClosing note",
              },
            },
          },
        });
        await page.goto(suite.server.baseUrl + "settings/memory");
        const tabs = page.locator(".memory-page .hub-tabs");
        const gapAbove = async (selector: string) => {
          const first = page.locator(selector).first();
          await expect(first).toBeVisible();
          const tabBottom = await tabs.evaluate((el) => el.getBoundingClientRect().bottom);
          return (await first.evaluate((el) => el.getBoundingClientRect().top)) - tabBottom;
        };
        const overview = await gapAbove(".memory-overview .settings-group");
        await page.locator("#memory-tab-memories").press("Enter");
        const memories = await gapAbove(".memory-memories__search");
        expect(memories).toBe(overview);
        // The space above the active panel should be smaller than the gap between unrelated sections.
        const sectionGap = await page
          .locator(".memory-memories")
          .evaluate((el) => Number.parseFloat(getComputedStyle(el).rowGap));
        expect(memories).toBeLessThan(sectionGap);
        await page.locator("#memory-search-input").fill("handoff");
        await page.locator("#memory-search-input").press("Enter");
        const group = page.locator(".memory-memories__results");
        const row = group.locator(".memory-memories__result").nth(1);
        const meta = row.locator(".memory-memories__meta");
        await meta.waitFor();
        const pathEl = meta.locator("code");
        const groupBox = await group.boundingBox();
        expect(groupBox!.x).toBeGreaterThanOrEqual(0);
        expect(groupBox!.x + groupBox!.width).toBeLessThanOrEqual(width + 1);
        const geometry = await pathEl.evaluate((el) => {
          const t = el.querySelector("bdi")!.firstChild!,
            r = document.createRange();
          r.selectNodeContents(t);
          const lines = new Set(Array.from(r.getClientRects(), (x) => x.top));
          r.setStart(t, t.textContent!.lastIndexOf("_") + 1);
          const end = r.getBoundingClientRect(),
            box = el.getBoundingClientRect();
          return [lines.size, end.left >= box.left - 1 && end.right <= box.right + 1];
        });
        expect(geometry).toEqual([1, true]);
        const choose = row.getByRole("button");
        await choose.press("Enter");
        await row.getByText("Verified handoff record", { exact: true }).waitFor();
        await expect(pathEl).toHaveCSS("white-space", "normal");
        await expect(pathEl).toHaveText(memoryPath);
        expect((await gw.getRequests("agents.workspace.get")).at(-1)?.params).toMatchObject({
          path: memoryPath,
        });
        await choose.press("Enter");
        await expect(choose).toHaveAttribute("aria-expanded", "false");
      },
    );
  });
  it("loads packaged JS and CSS in the actual Memory route, probes explicitly, and remounts after navigation", async () => {
    await suite.withPage({ ...pageOptions, serviceWorkers: "block" }, async ({ page }) => {
      const assets: Array<{ url: string; status: number }> = [];
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("response", (response) => {
        if (response.url().includes("/assets/plugins/memory-core/")) {
          assets.push({ url: response.url(), status: response.status() });
        }
      });
      const gateway = await installMockGateway(page, {
        assistantAgentId: "main",
        defaultAgentId: "main",
        communityInvite: false,
        methodResponses: memoryFixture(
          {
            agents: { entries: { main: {} } },
            plugins: { slots: { memory: "custom-memory" } },
          },
          "overview-config",
        ),
      });
      await page.goto(`${suite.server.baseUrl}settings/memory`);
      await waitForControlUiRoute(page, { routeId: "memory" });
      const overview = page.locator(".memory-overview");
      await expect(overview.getByRole("heading", { name: "Memory is awake" })).toBeVisible();
      const overviewStyles = await page
        .locator('link[rel="stylesheet"][href*="/assets/plugins/memory-core/"]')
        .elementHandles();
      expect(overviewStyles.length).toBeGreaterThan(0);
      await expect(overview).toContainText("custom-memory");
      await expect(overview.locator(".lob-reading-book")).toBeVisible();
      for (const title of ["Embeddings", "Provider"]) {
        const row = overview.locator(".settings-row", { hasText: title });
        await expect(row).toBeVisible();
        await expect(row).toHaveCSS("min-height", "48px");
        await expect(row).toHaveCSS("padding", "12px 16px");
      }
      await expect(overview.locator(".memory-overview__status")).toHaveCSS("display", "flex");
      await expect(overview.locator(".memory-overview__lobster")).toHaveCSS(
        "aspect-ratio",
        "120 / 105",
      );
      for (const ext of [".js", ".css"]) {
        expect(assets.some((asset) => asset.url.endsWith(ext) && asset.status === 200)).toBe(true);
      }
      const ordinary = await gateway.getRequests("doctor.memory.status");
      expect(ordinary).toHaveLength(1);
      expect(ordinary[0]?.params).toEqual({ agentId: "main" });
      await gateway.setMethodResponse("doctor.memory.status", {
        agentId: "main",
        provider: "local",
        embedding: { ok: false, checked: true, error: "embedding probe failed" },
      });
      await overview.getByRole("button", { name: "Test", exact: true }).click();
      await gateway.waitForRequest("doctor.memory.status", {
        match: { agentId: "main", probe: true },
      });
      await expect(overview).toContainText("embedding probe failed");
      await page.locator("#memory-tab-settings").click();
      await waitForControlUiRoute(page, {
        routeId: "memory",
        pathname: "/settings/memory/settings",
      });
      await expect(overview).toHaveCount(0);
      await expect
        .poll(() =>
          Promise.all(overviewStyles.map((style) => style.evaluate((link) => link.isConnected))),
        )
        .toEqual(overviewStyles.map(() => false));
      await page.locator("#memory-tab-overview").click();
      await waitForControlUiRoute(page, { routeId: "memory", pathname: "/settings/memory" });
      await expect(overview).toContainText("embedding probe failed");
      expect(await gateway.getRequests("doctor.memory.status")).toHaveLength(3);
      await gateway.setOnline(false);
      await gateway.closeLatest();
      await expect(overview).toContainText("gateway is offline");
      expect(await gateway.getRequests("doctor.memory.status")).toHaveLength(3);
      expect(errors).toEqual([]);
    });
  });
  it.each(["none", "memory-core"])(
    "keeps the packaged overview available for %s without runtime activation",
    async (slot) => {
      await suite.withPage(pageOptions, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          communityInvite: false,
          methodResponses: {
            ...memoryFixture({ plugins: { slots: { memory: slot } } }, "memory-off"),
            "plugins.list": {
              plugins: [
                {
                  id: "memory-core",
                  name: "Memory Core",
                  kind: ["memory"],
                  installed: true,
                  enabled: false,
                  state: "disabled",
                },
              ],
              diagnostics: [],
              mutationAllowed: true,
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/memory`);
        await waitForControlUiRoute(page, { routeId: "memory" });
        await expect(page.getByRole("heading", { name: "Memory is hibernating" })).toBeVisible();
        if (slot === "memory-core") {
          await gateway.waitForRequest("doctor.memory.status");
        }
        expect(await gateway.getRequests("doctor.memory.status")).toHaveLength(
          slot === "none" ? 0 : 1,
        );
        expect(await gateway.getRequests("plugins.controlUi.report")).toHaveLength(0);
      });
    },
  );
});
