import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { frames } from "../../../scripts/lib/control-ui-interaction-navigation.ts";
import { createReport, createSkill } from "../pages/skills/view.test-support.ts";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e-defaults.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { observeLayoutShifts } from "../test-helpers/control-ui-layout-shift.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Skills category discovery" });
const viewport = { width: 1280, height: 900 };
const taxonomy = [
  { slug: "research", label: "Research", icon: "search" },
  { slug: "development", label: "Development", icon: "wrench" },
  ...Array.from({ length: 12 }, (_, i) => ({ slug: "topic-" + i, label: "More topics " + i })),
];
function listing(displayName: string, summary: string, category?: string) {
  const slug = displayName.toLowerCase().replaceAll(" ", "-");
  return {
    slug,
    displayName,
    summary,
    categories: category ? [category] : [],
    score: 1,
    registry: "https://clawhub.ai",
    ownerHandle: "fieldnotes",
    installRef: `@fieldnotes/${slug}`,
  };
}
const index = listing("Release Digest", "Summarize the week's release notes.", "development");
const notebook = listing("Field Notebook", "Collect citations and notes in one place.", "research");
const handoff = listing("Team Handoff", "Prepare a concise handoff for a teammate.");
const overview = [
  index,
  notebook,
  listing("Reading Room", "Organize papers into a reading list.", "research"),
  listing("Change Review", "Summarize changes for a code review.", "development"),
  handoff,
];
const atlas = listing("Archive Atlas", "Trace a topic through historical records.");
const ledger = listing("Source Ledger", "Keep track of evidence and original sources.");
const installed = createSkill({
  name: "Daily Brief",
  skillKey: "daily-brief",
  description: "Prepare a morning briefing.",
  emoji: "🗓️",
});
function openCatalog(page: Page) {
  return installMockGateway(page, {
    featureMethods: [...defaultControlUiFeatureMethods, "skills.categories", "skills.detail"],
    methodResponses: {
      "skills.categories": { categories: taxonomy },
      "skills.status": createReport([installed]),
      "skills.search": { results: overview },
      "skills.detail": {
        skill: { ...ledger, createdAt: 1, updatedAt: 2 },
        owner: { handle: "fieldnotes" },
      },
    },
  });
}
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
async function expectSearch(
  gateway: Awaited<ReturnType<typeof openCatalog>>,
  match: Record<string, unknown>,
  after?: number,
) {
  expect((await gateway.waitForRequest("skills.search", { match, after })).params).toEqual(match);
}
const row = (page: Page, name: string) => page.getByRole("heading", { name, exact: true });

async function capture(page: Page, name: string, title: string) {
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF !== "1") {
    return;
  }
  const surface = page.locator(".skill-discovery");
  const frame = await takeControlUiScreenshotFrame(page, surface, [row(page, title)], {
    animations: "disabled",
  });
  await writeFile(path.join(suite.artifactDir, name + ".png"), frame.png);
}

const shelf = (page: Page, title: string) =>
  page.locator("[data-catalog-section]").filter({ has: row(page, title) });

suite.define(() => {
  for (const [size, dimensions] of [
    ["desktop", viewport],
    ["narrow", { width: 390, height: 844 }],
    ["phone", { width: 400, height: 900 }],
    ["tablet", { width: 820, height: 900 }],
  ] as const) {
    it(`groups the overview from one unfiltered page without horizontal overflow (${size})`, () =>
      suite.withPage({ viewport: dimensions, locale: "en-US" }, async ({ page }) => {
        const gateway = await openCatalog(page);
        await page.goto(suite.server.baseUrl + "plugins");
        await gateway.deferNext("skills.categories");
        if (dimensions.width <= 900) {
          await button(page, "Expand sidebar").click();
        }
        await page.getByRole("link", { name: "Skills", exact: true }).click();
        await expectSearch(gateway, { limit: 20 });
        await page.locator(".skill-installed-shelf").waitFor();
        await page.getByRole("status", { name: "Searching…" }).waitFor();
        expect(await row(page, notebook.displayName).isVisible()).toBe(false);
        const shifts = await observeLayoutShifts(page);
        await gateway.resolveDeferred("skills.categories");
        await row(page, notebook.displayName).waitFor();
        await frames(page);
        // Include recent-input entries: fast navigation must not mask directory-arrival shifts.
        expect(await shifts.evaluate((probe) => probe.read().entries)).toEqual([]);
        await shifts.dispose();
        const research = button(page, "Research");
        await research.waitFor();
        expect(await research.evaluate((chip) => chip.scrollWidth <= chip.clientWidth)).toBe(true);
        await capture(page, `overview-${size}`, notebook.displayName);

        for (const [section, skill] of [
          ["Research", notebook],
          ["Development", index],
          ["ClawHub", handoff],
        ] as const) {
          const group = shelf(page, section);
          await group.getByRole("heading", { name: skill.displayName, exact: true }).waitFor();
          const actions = group.getByRole("button", { name: "View all", exact: true });
          expect(await actions.count()).toBe(section === "ClawHub" ? 0 : 1);
        }
        expect(await gateway.getRequests("skills.search")).toHaveLength(1);
        expect(await gateway.getRequests("skills.categories")).toHaveLength(1);
        const content = page.locator("[data-catalog-section] :is(h2, article, button)");
        const fits = await content.evaluateAll((elements) =>
          elements.every((el) => {
            const { left, right } = el.getBoundingClientRect();
            return left >= -1 && right <= document.documentElement.clientWidth + 1;
          }),
        );
        expect(fits).toBe(true);
      }));
  }

  it("opens the complete category from View all and resumes its exact cursor on retry", () =>
    suite.withPage({ viewport, locale: "en-US" }, async ({ page }) => {
      const gateway = await openCatalog(page);
      await page.goto(suite.server.baseUrl + "skills");
      await row(page, index.displayName).waitFor();
      expect(await row(page, atlas.displayName).count()).toBe(0);
      await gateway.setMethodResponse("skills.search", {
        results: [atlas],
        nextCursor: "research:page-2",
      });
      await shelf(page, "Research").getByRole("button", { name: "View all", exact: true }).click();
      const category = { category: "research", limit: 20 };
      await expectSearch(gateway, category);
      await row(page, atlas.displayName).waitFor();
      expect(await row(page, index.displayName).count()).toBe(0);
      await capture(page, "research-skills", atlas.displayName);

      const more = button(page, "Load more");
      const next = { ...category, cursor: "research:page-2" };
      await gateway.deferNext("skills.search", next);
      await more.click();
      await expectSearch(gateway, next);
      const failure = { code: "UNAVAILABLE", message: "Next page unavailable" };
      await gateway.rejectDeferred("skills.search", failure, { match: next });
      const error = page.getByRole("alert").filter({ hasText: failure.message });
      await error.waitFor();
      expect(await row(page, atlas.displayName).isVisible()).toBe(true);
      await gateway.setMethodResponse("skills.search", { results: [ledger] });
      await error.getByRole("button", { name: "Retry" }).click();
      await expectSearch(gateway, next, 1);
      await row(page, ledger.displayName).waitFor();
      expect(await row(page, atlas.displayName).isVisible()).toBe(true);
      expect(await more.count()).toBe(0);
      await button(page, "Open Source Ledger details").click();
      const detail = await gateway.waitForRequest("skills.detail");
      expect(detail.params).toEqual({ slug: ledger.installRef });
      await row(page, ledger.displayName).waitFor();
      expect(await gateway.getRequests("skills.install")).toHaveLength(0);
    }));

  it("keeps focus through search and discards retired category pages across All and Installed", () =>
    suite.withPage({ viewport }, async ({ page }) => {
      const gateway = await openCatalog(page);
      await page.goto(suite.server.baseUrl + "skills");
      await row(page, index.displayName).waitFor();
      const scoped = { category: "research", limit: 20 };
      // Clearing text keeps the category, but returning to All retires its in-flight read.
      const search = page.getByRole("searchbox", { name: "Search skills" });
      await search.focus();
      await page.keyboard.type("cit");
      await gateway.waitForRequest("skills.search", { match: { query: "cit" } });
      await shelf(page, "ClawHub").getByRole("heading", { name: notebook.displayName }).waitFor();
      // Use the keyboard, not locator.fill/type: those would silently refocus a replacement input.
      await page.keyboard.type("ations");
      expect(await search.inputValue()).toBe("citations");
      expect(await search.evaluate((input) => input === document.activeElement)).toBe(true);
      await gateway.waitForRequest("skills.search", { match: { query: "citations" } });
      // The registry found this semantic match even though neither its copy nor the category contains the query.
      await gateway.setMethodResponse("skills.search", { results: [atlas] });
      await button(page, "Research").click();
      const query = { ...scoped, query: "citations" };
      await expectSearch(gateway, query);
      await row(page, atlas.displayName).waitFor();
      await capture(page, "research-citations", atlas.displayName);
      expect(await button(page, "Load more").count()).toBe(0);
      await gateway.deferNext("skills.search", scoped, { exactParams: true });
      await search.fill("");
      await gateway.waitForRequest("skills.search", { match: scoped, exactParams: true });
      await gateway.setMethodResponse("skills.search", { results: overview });
      await button(page, "All").click();
      await row(page, index.displayName).waitFor();
      const retired = { results: [ledger], nextCursor: "retired" };
      await gateway.resolveDeferred("skills.search", retired, { match: scoped });
      await button(page, "Installed").click();
      await button(page, "Open Daily Brief details").waitFor();
      expect(await row(page, index.displayName).count()).toBe(0);
      await button(page, "All").click();
      await shelf(page, "Development").getByRole("heading", { name: index.displayName }).waitFor();
      expect(await row(page, ledger.displayName).count()).toBe(0);
      expect(await button(page, "Load more").count()).toBe(0);
    }));
});
