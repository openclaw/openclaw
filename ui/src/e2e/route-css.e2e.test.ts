import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI route CSS mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

async function probeStyles(
  page: Page,
  markup: string,
  fields: [string, string][],
  cssClass = "",
  tagName: "div" | "article" = "div",
) {
  return page.evaluate(
    ({ html, properties, className, tag }) => {
      const probe = document.createElement(tag);
      probe.className = className;
      probe.innerHTML = html;
      document.body.append(probe);
      const styles = properties.map(([selector, property]) =>
        getComputedStyle(probe.querySelector(selector)!).getPropertyValue(property),
      );
      probe.remove();
      return styles;
    },
    { html: markup, properties: fields, className: cssClass, tag: tagName },
  );
}

suite.define(() => {
  it("loads shared Markdown and session-link styles on direct Cron, Skills, and Chat routes", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const openRoute = async (path: string, ready: Locator) => {
        expect((await page.goto(`${suite.server.baseUrl}${path}`))?.status()).toBe(200);
        await ready.waitFor();
      };
      const emptyPage = { total: 0, offset: 0, limit: 50, hasMore: false, nextOffset: null };
      await installMockGateway(page, {
        methodResponses: {
          "cron.list": { ...emptyPage, jobs: [] },
          "cron.runs": { ...emptyPage, entries: [] },
          "cron.status": { enabled: true, jobs: 0, nextWakeAtMs: null },
          "skills.status": {
            workspaceDir: "/tmp/openclaw-e2e/workspace",
            managedSkillsDir: "/tmp/openclaw-e2e/skills",
            skills: [],
          },
        },
      });

      await openRoute("cron", page.locator(".cron-page"));

      const [padding, listGap, listFontSize, ...cronStyles] = await probeStyles(
        page,
        `
          <div class="chat-text"><ul><li>First</li><li>Second</li></ul><pre><code>code</code></pre></div>
          <a class="session-link">session</a>
        `,
        [
          ["ul", "padding-left"],
          ["li + li", "margin-top"],
          ["li + li", "font-size"],
          ["pre", "border-top-style"],
          ["pre", "overflow-x"],
          [".session-link", "font-weight"],
          [".session-link", "text-decoration-line"],
        ],
      );
      expect(Number.parseFloat(padding!)).toBeGreaterThan(0);
      expect(Number.parseFloat(listGap!) / Number.parseFloat(listFontSize!)).toBeCloseTo(0.4, 2);
      expect(cronStyles).toEqual(["solid", "auto", "500", "none"]);

      await openRoute(
        "skills",
        page.getByRole("searchbox", { name: "Search skills", exact: true }),
      );

      expect(
        await probeStyles(
          page,
          `
          <h2>Heading</h2>
          <ul><li class="task-list-item">Task</li></ul>
          <pre><code>code</code></pre>
          <table><tbody><tr><td>Cell</td></tr></tbody></table>
        `,
          [
            ["h2", "border-bottom-style"],
            ["pre", "overflow-x"],
            ["table", "display"],
            [".task-list-item", "list-style-type"],
          ],
          "sidebar-markdown",
          "article",
        ),
      ).toEqual(["solid", "auto", "block", "none"]);

      await openRoute("chat?session=main", page.locator("openclaw-chat-page"));

      const chatMarkdownStyles = await page.evaluate(() => {
        const probe = document.createElement("div");
        probe.className = "chat-text";
        probe.style.width = "900px";
        probe.innerHTML = `
          <ol class="probe-list"><li>First</li></ol>
          <blockquote class="probe-quote"><p>Quoted block</p></blockquote>
          <table>
            <thead><tr><th>Dimension</th><th>Sentiment signal</th></tr></thead>
            <tbody><tr><td>Demographics</td><td>Experience-dependent sentiment.</td></tr></tbody>
          </table>
          <p class="probe-table-copy"><strong>Overall characterization:</strong> Pragmatic adoption under suspicion.</p>
          <ul class="probe-task-list"><li class="task-list-item"><input class="task-list-item-checkbox" type="checkbox" disabled /> Task</li></ul>
          <details class="probe-details"><summary>More details</summary><p>Body</p></details>
          <ul class="probe-unordered"><li>Unordered</li></ul>
          <ol class="probe-ordered"><li>Ordered</li></ol>
        `;
        document.body.append(probe);
        const element = (selector: string) => probe.querySelector(selector)!;
        const dimension = element("th:first-child");
        const gap = (before: string, after: string) =>
          element(after).getBoundingClientRect().top -
          element(before).getBoundingClientRect().bottom;
        const margin = (selector: string) =>
          Number.parseFloat(getComputedStyle(element(selector)).marginTop);
        const lineCount = (target: Element) => {
          const range = document.createRange();
          range.selectNodeContents(target);
          return new Set(Array.from(range.getClientRects(), (rect) => Math.round(rect.top))).size;
        };
        const fontSize = Number.parseFloat(getComputedStyle(element(".probe-table-copy")).fontSize);
        const result = {
          lines: [lineCount(dimension), lineCount(element("td:first-child"))],
          firstColumnWidth: dimension.getBoundingClientRect().width,
          gaps: [
            gap(".probe-list", ".probe-quote"),
            gap("table", ".probe-table-copy"),
            gap(".probe-task-list", ".probe-details"),
            gap(".probe-unordered", ".probe-ordered"),
          ],
          margins: [".probe-quote", ".probe-table-copy", ".probe-details", ".probe-ordered"].map(
            (selector) => margin(selector) / fontSize,
          ),
        };
        probe.remove();
        return result;
      });
      expect(chatMarkdownStyles.lines).toEqual([1, 1]);
      expect(chatMarkdownStyles.firstColumnWidth).toBeGreaterThanOrEqual(128);
      for (const gap of chatMarkdownStyles.gaps) {
        expect(gap).toBeGreaterThan(0);
      }
      for (const margin of chatMarkdownStyles.margins) {
        expect(margin).toBeCloseTo(1, 2);
      }
    });
  });
});
