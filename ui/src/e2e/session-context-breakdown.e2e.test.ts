import { expect, it } from "vitest";
import type { SessionSystemPromptReport } from "../../../src/config/sessions/session-system-prompt-report.js";
import { waitForControlUiFrameLayout } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { openChatDetails } from "./chat-details.test-support.ts";
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
  skills: { promptChars: 8000, entries: [{ name: "code-review", blockChars: 8000 }] },
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
      const panel = await openChatDetails(page);
      expect(breakdownRequests).toHaveLength(0);
      const context =
        width <= 900
          ? panel.locator('.chat-mobile-details-page[data-details-page="context"]')
          : panel.locator('[data-details-group="context"]');
      if (width <= 900) {
        await panel.locator('[data-details-destination="context"]').click();
      } else {
        await context.locator(":scope > summary").click();
      }
      await context.getByText("Workspace files", { exact: true }).waitFor();
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
      await context.locator('[data-context-details="files"] > summary').click();
      await context.getByText("AGENTS.md", { exact: true }).first().waitFor();
      expect(await context.getByText("AGENTS.md", { exact: true }).count()).toBe(2);
      await context.getByText("Agent workspace", { exact: true }).waitFor();
      await context.getByText("Project · openclaw", { exact: true }).waitFor();
      await context.getByText("/projects/openclaw/AGENTS.md", { exact: true }).waitFor();
      await context.getByText("Available on demand", { exact: true }).waitFor();
      await context.getByRole("button", { name: "Compact session", exact: true }).waitFor();
      const contextScrollport =
        width <= 900 ? context.locator(".chat-mobile-details-page__body") : context;
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      await waitForControlUiFrameLayout([contextScrollport]);
      expect(
        await contextScrollport.evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
      await context.locator('[data-context-details="files"] > summary').click();
      await context.locator('[data-context-details="tools"] > summary').click();
      await context.getByText("System tools", { exact: true }).waitFor();
      await context
        .locator('[data-context-details="tools"]')
        .getByText("MCP tools · Docs", { exact: true })
        .waitFor();
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
        await context.getByRole("button", { name: "Compact session", exact: true }).click();
        const compact = await gateway.waitForRequest("sessions.compact");
        expect(compact.params).toMatchObject({ key: sessionKey });
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
        await context.getByText("Workspace files", { exact: true }).waitFor();
        await context.locator('[data-context-details="files"] > summary').click();
        await context.getByText("Unverified", { exact: true }).waitFor();
        await expect
          .poll(() => context.locator('[data-context-category="messages"]').textContent())
          .toContain("—");
      }
    });
  });
});
