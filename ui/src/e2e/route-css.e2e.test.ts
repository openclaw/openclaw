// Control UI tests prove route-scoped CSS on fresh direct navigation.
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

suite.define(() => {
  it("loads shared Markdown and session-link styles on direct Cron, Skills, and Chat routes", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
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

      const cronResponse = await page.goto(`${suite.server.baseUrl}cron`);
      expect(cronResponse?.status()).toBe(200);
      await page.locator(".cron-page").waitFor();

      const cronStyles = await page.evaluate(() => {
        const probe = document.createElement("div");
        probe.innerHTML = `
          <div class="chat-text"><ul><li>First</li><li>Second</li></ul><pre><code>code</code></pre></div>
          <a class="session-link">session</a>
        `;
        document.body.append(probe);
        const style = (selector: string) => {
          const element = probe.querySelector(selector);
          if (!element) {
            throw new Error(`Cron style probe missing ${selector}`);
          }
          return getComputedStyle(element);
        };
        const listItemStyle = style("li + li");
        const result = {
          listPadding: Number.parseFloat(style("ul").paddingLeft),
          listItemGap: Number.parseFloat(listItemStyle.marginTop),
          listItemFontSize: Number.parseFloat(listItemStyle.fontSize),
          preBorderStyle: style("pre").borderTopStyle,
          preOverflow: style("pre").overflowX,
          sessionFontWeight: style(".session-link").fontWeight,
          sessionTextDecoration: style(".session-link").textDecorationLine,
        };
        probe.remove();
        return result;
      });
      expect(cronStyles.listPadding).toBeGreaterThan(0);
      expect(cronStyles.listItemGap / cronStyles.listItemFontSize).toBeCloseTo(0.4, 2);
      expect(cronStyles).toMatchObject({
        preBorderStyle: "solid",
        preOverflow: "auto",
        sessionFontWeight: "500",
        sessionTextDecoration: "none",
      });

      const skillsResponse = await page.goto(`${suite.server.baseUrl}skills`);
      expect(skillsResponse?.status()).toBe(200);
      await page.getByRole("searchbox", { name: "Search skills", exact: true }).waitFor();

      const skillsStyles = await page.evaluate(() => {
        const probe = document.createElement("article");
        probe.className = "sidebar-markdown";
        probe.innerHTML = `
          <h2>Heading</h2>
          <ul><li class="task-list-item">Task</li></ul>
          <pre><code>code</code></pre>
          <table><tbody><tr><td>Cell</td></tr></tbody></table>
        `;
        document.body.append(probe);
        const style = (selector: string) => {
          const element = probe.querySelector(selector);
          if (!element) {
            throw new Error(`Skills style probe missing ${selector}`);
          }
          return getComputedStyle(element);
        };
        const result = {
          headingBorderStyle: style("h2").borderBottomStyle,
          preOverflow: style("pre").overflowX,
          tableDisplay: style("table").display,
          taskListStyle: style(".task-list-item").listStyleType,
        };
        probe.remove();
        return result;
      });
      expect(skillsStyles).toEqual({
        headingBorderStyle: "solid",
        preOverflow: "auto",
        tableDisplay: "block",
        taskListStyle: "none",
      });

      const chatResponse = await page.goto(`${suite.server.baseUrl}chat?session=main`);
      expect(chatResponse?.status()).toBe(200);
      await page.locator("openclaw-chat-page").waitFor();

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
        const element = (selector: string) => {
          const found = probe.querySelector(selector);
          if (!found) {
            throw new Error(`Chat Markdown style probe missing ${selector}`);
          }
          return found;
        };
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
        const result = {
          demographicsLineCount: lineCount(element("td:first-child")),
          dimensionLineCount: lineCount(dimension),
          firstColumnWidth: dimension.getBoundingClientRect().width,
          listToQuoteGap: gap(".probe-list", ".probe-quote"),
          quoteMargin: margin(".probe-quote"),
          tableToCopyGap: gap("table", ".probe-table-copy"),
          tableCopyMargin: margin(".probe-table-copy"),
          taskListToDetailsGap: gap(".probe-task-list", ".probe-details"),
          detailsMargin: margin(".probe-details"),
          unorderedToOrderedGap: gap(".probe-unordered", ".probe-ordered"),
          orderedMargin: margin(".probe-ordered"),
          blockFontSize: Number.parseFloat(getComputedStyle(element(".probe-table-copy")).fontSize),
        };
        probe.remove();
        return result;
      });
      expect(chatMarkdownStyles.dimensionLineCount).toBe(1);
      expect(chatMarkdownStyles.demographicsLineCount).toBe(1);
      expect(chatMarkdownStyles.firstColumnWidth).toBeGreaterThanOrEqual(128);
      expect(chatMarkdownStyles.listToQuoteGap).toBeGreaterThan(0);
      expect(chatMarkdownStyles.tableToCopyGap).toBeGreaterThan(0);
      expect(chatMarkdownStyles.taskListToDetailsGap).toBeGreaterThan(0);
      expect(chatMarkdownStyles.unorderedToOrderedGap).toBeGreaterThan(0);
      expect(chatMarkdownStyles.quoteMargin / chatMarkdownStyles.blockFontSize).toBeCloseTo(1, 2);
      expect(chatMarkdownStyles.tableCopyMargin / chatMarkdownStyles.blockFontSize).toBeCloseTo(
        1,
        2,
      );
      expect(chatMarkdownStyles.detailsMargin / chatMarkdownStyles.blockFontSize).toBeCloseTo(1, 2);
      expect(chatMarkdownStyles.orderedMargin / chatMarkdownStyles.blockFontSize).toBeCloseTo(1, 2);
    });
  });
});
