import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createReport, createSkill } from "../pages/skills/view.test-support.ts";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e-defaults.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Skills category discovery" });
const viewport = { width: 1280, height: 900 };
const taxonomy = [
  { slug: "research", label: "Research", icon: "search" },
  { slug: "development", label: "Development", icon: "wrench" },
];
function listing(slug: string, displayName: string, summary: string, categories: string[] = []) {
  return {
    slug,
    displayName,
    summary,
    categories,
    score: 1,
    registry: "https://clawhub.ai",
    ownerHandle: "fieldnotes",
    installRef: `@fieldnotes/${slug}`,
  };
}
const index = listing(
  "release-digest",
  "Release Digest",
  "Turn release notes into a short weekly digest.",
  ["development"],
);
const notebook = listing(
  "field-notebook",
  "Field Notebook",
  "Collect citations and notes in one place.",
  ["research"],
);
const readingRoom = listing(
  "reading-room",
  "Reading Room",
  "Organize papers into a reading list.",
  ["research"],
);
const changelog = listing(
  "change-review",
  "Change Review",
  "Summarize changes for a code review.",
  ["development"],
);
const handoff = listing(
  "team-handoff",
  "Team Handoff",
  "Prepare a concise handoff for a teammate.",
);
const overview = [index, notebook, readingRoom, changelog, handoff];
const atlas = listing(
  "archive-atlas",
  "Archive Atlas",
  "Trace a topic through historical records.",
);
const ledger = listing(
  "source-ledger",
  "Source Ledger",
  "Keep track of evidence and original sources.",
);
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
        skill: {
          slug: ledger.slug,
          displayName: ledger.displayName,
          summary: ledger.summary,
          createdAt: 1,
          updatedAt: 2,
        },
        owner: { handle: "fieldnotes" },
      },
    },
  });
}
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const row = (page: Page, name: string) => page.getByRole("heading", { name, exact: true });

async function capture(page: Page, name: string, title: string) {
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF !== "1") {
    return;
  }
  const frame = await takeControlUiScreenshotFrame(
    page,
    page.locator(".skill-discovery"),
    [row(page, title)],
    { animations: "disabled" },
  );
  await writeFile(path.join(suite.artifactDir, name + ".png"), frame.png);
}

const shelf = (page: Page, title: string) =>
  page.locator("[data-catalog-section]").filter({ has: row(page, title) });

suite.define(() => {
  for (const [size, dimensions] of [
    ["desktop", viewport],
    ["narrow", { width: 390, height: 844 }],
  ] as const) {
    it(`groups the overview from one unfiltered page without horizontal overflow (${size})`, () =>
      suite.withPage({ viewport: dimensions, locale: "en-US" }, async ({ page }) => {
        const gateway = await openCatalog(page);
        await page.goto(suite.server.baseUrl + "skills");
        await row(page, notebook.displayName).waitFor();
        await button(page, "Research").waitFor();
        await capture(page, `overview-${size}`, notebook.displayName);

        const research = shelf(page, "Research");
        const development = shelf(page, "Development");
        for (const [section, name] of [
          [research, notebook.displayName],
          [development, index.displayName],
        ] as const) {
          expect(await section.getByRole("heading", { name }).isVisible()).toBe(true);
          expect(
            await section.getByRole("button", { name: "View all", exact: true }).isVisible(),
          ).toBe(true);
        }
        const uncategorized = page.locator('[data-catalog-section="clawhub"]');
        expect(
          await uncategorized.getByRole("heading", { name: handoff.displayName }).isVisible(),
        ).toBe(true);
        expect(
          await uncategorized.getByRole("heading", { name: notebook.displayName }).count(),
        ).toBe(0);
        expect((await gateway.getRequests("skills.search")).map(({ params }) => params)).toEqual([
          { limit: 20 },
        ]);
        expect(await gateway.getRequests("skills.categories")).toHaveLength(1);
        const bounds = await page
          .locator("[data-catalog-section] :is(h2, article, button)")
          .evaluateAll((elements) => ({
            viewport: document.documentElement.clientWidth,
            document: document.documentElement.scrollWidth,
            leaking: elements
              .map((element) => ({
                label: element.textContent?.trim(),
                rect: element.getBoundingClientRect(),
              }))
              .filter(
                ({ rect }) =>
                  rect.width > 0 &&
                  (rect.left < -1 || rect.right > document.documentElement.clientWidth + 1),
              )
              .map(({ label }) => label),
          }));
        expect(bounds.document).toBe(bounds.viewport);
        expect(bounds.leaking).toEqual([]);
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
      expect((await gateway.waitForRequest("skills.search", { match: category })).params).toEqual(
        category,
      );
      await row(page, atlas.displayName).waitFor();
      expect(await row(page, index.displayName).count()).toBe(0);
      await capture(page, "research-skills", atlas.displayName);

      const more = button(page, "Load more");
      const next = { ...category, cursor: "research:page-2" };
      await gateway.deferNext("skills.search", next);
      await more.click();
      expect((await gateway.waitForRequest("skills.search", { match: next })).params).toEqual(next);
      await gateway.rejectDeferred(
        "skills.search",
        { code: "UNAVAILABLE", message: "Next page unavailable" },
        { match: next },
      );
      const error = page.getByRole("alert").filter({ hasText: "Next page unavailable" });
      await error.waitFor();
      expect(await row(page, atlas.displayName).isVisible()).toBe(true);
      await gateway.setMethodResponse("skills.search", { results: [ledger] });
      await error.getByRole("button", { name: "Retry" }).click();
      expect(
        (await gateway.waitForRequest("skills.search", { match: next, after: 1 })).params,
      ).toEqual(next);
      await row(page, ledger.displayName).waitFor();
      expect(await row(page, atlas.displayName).isVisible()).toBe(true);
      expect(await more.count()).toBe(0);
      await button(page, "Open Source Ledger details").click();
      expect((await gateway.waitForRequest("skills.detail")).params).toEqual({
        slug: ledger.installRef,
      });
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
      expect((await gateway.waitForRequest("skills.search", { match: query })).params).toEqual(
        query,
      );
      await row(page, atlas.displayName).waitFor();
      await capture(page, "research-citations", atlas.displayName);
      expect(await button(page, "Load more").count()).toBe(0);
      await gateway.deferNext("skills.search", scoped, { exactParams: true });
      await search.fill("");
      await gateway.waitForRequest("skills.search", { match: scoped, exactParams: true });
      await gateway.setMethodResponse("skills.search", { results: overview });
      await button(page, "All").click();
      await row(page, index.displayName).waitFor();
      await gateway.resolveDeferred(
        "skills.search",
        { results: [ledger], nextCursor: "retired" },
        { match: scoped },
      );
      await button(page, "Installed").click();
      await button(page, "Open Daily Brief details").waitFor();
      expect(await row(page, index.displayName).count()).toBe(0);
      await button(page, "All").click();
      await shelf(page, "Development").getByRole("heading", { name: index.displayName }).waitFor();
      expect(await row(page, ledger.displayName).count()).toBe(0);
      expect(await button(page, "Load more").count()).toBe(0);
    }));
});
