import { expect, it } from "vitest";
import type { SessionSystemPromptReport } from "../../../src/config/sessions/session-system-prompt-report.js";
import { waitForControlUiFrameLayout } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { closeChatDetails, openChatDetails } from "./chat-details.test-support.ts";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Sidebar context breakdown" });
const sessionKey = "agent:main:context-breakdown";
const workspaceFile = (
  path: string,
  rootPath: string,
  kind: "agent-workspace" | "execution-project",
  chars: number,
) => ({
  name: path.split("/").at(-1)!,
  path,
  origin: { kind, rootPath },
  missing: false,
  rawChars: chars,
  injectedChars: chars,
  truncated: false,
});
const report: SessionSystemPromptReport = {
  source: "run",
  generatedAt: 1,
  sessionId: "context-instance",
  sessionKey,
  workspaceDir: "/projects/openclaw",
  systemPrompt: { chars: 40000, projectContextChars: 16000, nonProjectContextChars: 24000 },
  injectedWorkspaceFiles: [
    workspaceFile("/workspace/AGENTS.md", "/workspace", "agent-workspace", 12000),
    workspaceFile("/workspace/USER.md", "/workspace", "agent-workspace", 2000),
    workspaceFile("/projects/openclaw/AGENTS.md", "/projects/openclaw", "execution-project", 2000),
  ],
  skills: {
    promptChars: 8000,
    entries: Array.from({ length: 98 }, (_, index) => ({
      name: index === 0 ? "code-review" : `project-skill-${index + 1}`,
      blockChars: index < 62 ? 82 : 81,
    })),
  },
  tools: {
    listChars: 0,
    schemaChars: 12000,
    entries: [
      { name: "exec", source: "openclaw", summaryChars: 800, schemaChars: 8000 },
      {
        name: "read_docs",
        source: "mcp",
        serverName: "Docs",
        summaryChars: 100,
        schemaChars: 4000,
      },
    ],
    deferred: {
      schemaChars: 30000,
      entries: [{ name: "search_docs", source: "mcp", serverName: "Docs", schemaChars: 30000 }],
    },
  },
};

suite.define(() => {
  it.each([
    { width: 1440, height: 1000, mode: "dark" as const },
    { width: 390, height: 844, mode: "light" as const },
  ])("shows a scoped, non-overlapping breakdown ($width px)", async ({ width, height, mode }) => {
    await suite.withPage({ viewport: { width, height }, colorScheme: mode }, async ({ page }) => {
      const breakdownModule = controlUiE2eBuiltModuleRequest(
        "ui/src/pages/chat/components/chat-context-breakdown.tsx",
      );
      const breakdownRequests: string[] = [];
      page.on("request", (request) => {
        if (breakdownModule.test(request.url())) {
          breakdownRequests.push(request.url());
        }
      });
      const gateway = await installMockGateway(page, {
        sessionKey,
        sessions: [
          {
            key: sessionKey,
            sessionId: "context-instance",
            kind: "direct",
            label: "Context breakdown",
            model: "demo-model",
            modelProvider: "example",
            contextTokens: 100000,
            totalTokens: 50000,
            totalTokensFresh: true,
          },
        ],
        agentModel: "example/demo-model",
        models: [
          { id: "demo-model", provider: "example", name: "Demo model", contextWindow: 100000 },
        ],
        historyMessages: [
          {
            role: "assistant",
            content:
              "The context inspector separates conversation, workspace memory, skills, and tools.",
          },
        ],
        methodResponses: {
          "sessions.compact": { ok: true, compacted: true },
          "sessions.usage": {
            sessions: [{ key: sessionKey, sessionId: "context-instance", contextWeight: report }],
          },
          "cron.list": {
            jobs: [],
            snapshotRevision: "empty",
            offset: 0,
            limit: 50,
            total: 0,
            hasMore: false,
            nextOffset: null,
          },
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await gateway.waitForRequest("chat.startup");
      const details = await openChatDetails(page);
      expect(breakdownRequests).toHaveLength(0);
      expect(
        await details
          .locator('[data-details-group="context"], [data-details-destination="context"]')
          .count(),
      ).toBe(0);
      await closeChatDetails(page);
      if (width <= 900) {
        await page
          .locator(".agent-chat__composer-combobox > textarea")
          .filter({ visible: true })
          .click();
      }
      await page.locator(".context-ring").filter({ visible: true }).click();
      const summary = page.locator(".context-usage__popover").filter({ visible: true });
      await summary.locator('[data-context-category="files"]').waitFor();
      expect(await summary.locator("[data-context-category]").count()).toBe(5);
      expect(await summary.getByRole("button", { name: /Refresh|Compact/ }).count()).toBe(0);
      expect(await summary.locator("button[data-context-category]").count()).toBe(0);
      const summarySegments = await summary
        .locator(".chat-context__segment")
        .evaluateAll((segments) => segments.map((segment) => segment.getAttribute("style")));
      expect(summarySegments).toHaveLength(5);
      await summary.getByRole("button", { name: "View context", exact: true }).click();
      await summary.waitFor({ state: "hidden" });
      const panel = page.locator("openclaw-chat-context-panel");
      const context = panel.locator(".chat-context-panel");
      await context
        .locator('[data-context-section="files"] .chat-context__entry')
        .first()
        .waitFor();
      expect(await context.locator("meter").getAttribute("aria-valuetext")).toContain("50%");
      expect(
        await context
          .locator(".chat-context__segment")
          .evaluateAll((segments) => segments.map((segment) => segment.getAttribute("style"))),
      ).toEqual(summarySegments);
      expect((await gateway.getRequests("sessions.usage")).length).toBe(1);
      expect(await context.getByRole("button", { name: "Back", exact: true }).count()).toBe(0);
      expect(breakdownRequests).toHaveLength(1);
      const request = await gateway.waitForRequest("sessions.usage");
      expect(request.params).toMatchObject({
        key: sessionKey,
        includeContextWeight: true,
        limit: 1,
      });
      await expect
        .poll(() => context.locator('[data-context-category="system"]').textContent())
        .toContain("4k");
      await expect
        .poll(() => context.locator('[data-context-category="messages"]').textContent())
        .toContain("37k");
      await context.getByText("AGENTS.md", { exact: true }).first().waitFor();
      expect(await context.getByText("AGENTS.md", { exact: true }).count()).toBe(2);
      await context.getByText("Agent workspace", { exact: true }).waitFor();
      await context.getByText("Project · openclaw", { exact: true }).waitFor();
      await context.getByText("/projects/openclaw/AGENTS.md", { exact: true }).waitFor();
      await context.getByText("On-demand tools", { exact: true }).waitFor();
      await context.getByRole("button", { name: "Compact session", exact: true }).waitFor();
      await context.getByText("AGENTS.md", { exact: true }).first().scrollIntoViewIfNeeded();
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      await waitForControlUiFrameLayout([context]);
      expect(await context.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      await context.getByText("System tools", { exact: true }).waitFor();
      await context
        .locator('[data-context-section="tools"]')
        .getByText("MCP tools · Docs", { exact: true })
        .waitFor();
      expect(
        await context.locator('[data-context-section="skills"] .chat-context__entry').count(),
      ).toBe(98);
      expect(
        await context
          .locator(".chat-context__entries")
          .evaluateAll((lists) =>
            lists.every((list) => !["auto", "scroll"].includes(getComputedStyle(list).overflowY)),
          ),
      ).toBe(true);
      const finalSkill = context.getByText("project-skill-98", { exact: true });
      await finalSkill.scrollIntoViewIfNeeded();
      expect(await finalSkill.isVisible()).toBe(true);
      expect(await context.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      if (width > 900) {
        const sideHeader = page.locator('[data-region-header="side"]');
        await sideHeader.getByRole("button", { name: "New tab", exact: true }).click();
        await page.locator(".side-panel-launcher").waitFor();
        await sideHeader.getByRole("button", { name: "Close New tab", exact: true }).click();
        await finalSkill.waitFor();
        expect(
          await finalSkill.evaluate((element) => {
            const row = element.getBoundingClientRect();
            const viewport = element.closest(".chat-context-panel")!.getBoundingClientRect();
            return row.top >= viewport.top && row.bottom <= viewport.bottom;
          }),
        ).toBe(true);
      }
      await context.locator('[data-context-details="deferred"] > summary').click();
      await context.getByText("search_docs", { exact: true }).waitFor();
      expect(await context.locator('[data-context-category="tools"]').textContent()).toContain(
        "3k",
      );
      if (width > 900) {
        const draft = page.locator(
          'openclaw-chat-pane[aria-hidden="false"] .agent-chat__composer-combobox > textarea',
        );
        await draft.fill("Keep this unsent draft");
        const beforeCompact = await gateway.deferNext("sessions.compact", { key: sessionKey });
        await context.getByRole("button", { name: "Compact session", exact: true }).click();
        const compact = await gateway.waitForRequest("sessions.compact", {
          after: beforeCompact,
          match: { key: sessionKey },
        });
        expect(compact.params).toMatchObject({ key: sessionKey });
        const compacting = context.getByRole("button", { name: "Compacting…", exact: true });
        await compacting.waitFor();
        expect(await compacting.isDisabled()).toBe(true);
        expect(await draft.inputValue()).toBe("Keep this unsent draft");
        await gateway.resolveDeferred(
          "sessions.compact",
          { ok: true, compacted: true },
          { match: { key: sessionKey } },
        );
        await context.getByRole("button", { name: "Compact session", exact: true }).waitFor();
        expect(await draft.inputValue()).toBe("Keep this unsent draft");
        await gateway.setMethodResponse("sessions.usage", { sessions: [] });
        await context.getByRole("button", { name: "Refresh", exact: true }).click();
        await context.getByText("No matching context report.", { exact: false }).waitFor();
        const nativeReport: SessionSystemPromptReport = {
          ...report,
          injectedWorkspaceFiles: [
            {
              name: "AGENTS.md",
              path: "/workspace/AGENTS.md",
              missing: false,
              rawChars: 16000,
              injectionStatus: "native_unverified",
              injectedChars: null,
              truncated: null,
            },
          ],
        };
        await gateway.setMethodResponse("sessions.usage", {
          sessions: [
            { key: sessionKey, sessionId: "context-instance", contextWeight: nativeReport },
          ],
        });
        await context.getByRole("button", { name: "Refresh", exact: true }).click();
        await context
          .locator('[data-context-section="files"] .chat-context__entry')
          .first()
          .waitFor();
        await context.getByText("Unverified", { exact: true }).waitFor();
        await expect
          .poll(() => context.locator('[data-context-category="messages"]').textContent())
          .toContain("—");
      }
    });
  });
});
