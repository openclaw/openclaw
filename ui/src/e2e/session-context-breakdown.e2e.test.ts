import { expect, it } from "vitest";
import type { SessionSystemPromptReport } from "../../../src/config/sessions/session-system-prompt-report.js";
import { waitForControlUiFrameLayout } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiSessionUrl,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { closeChatDetails, openChatDetails } from "./chat-details.test-support.ts";
import { dockChatSidePanel } from "./chat-side-panel.test-support.ts";
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
  it("compacts from the composer popover and shows the result without closing it", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 1000 } }, async ({ page }) => {
      const session = {
        key: sessionKey,
        sessionId: "context-instance",
        kind: "direct" as const,
        label: "Context breakdown",
        model: "demo-model",
        modelProvider: "example",
        contextTokens: 100000,
        totalTokens: 95000,
        totalTokensFresh: true,
      };
      const gateway = await installMockGateway(page, {
        sessionKey,
        sessions: [session],
        agentModel: "example/demo-model",
        models: [
          { id: "demo-model", provider: "example", name: "Demo model", contextWindow: 100000 },
        ],
        historyMessages: [{ role: "assistant", content: "Ready when you are." }],
        methodResponses: {
          "sessions.usage": {
            sessions: [{ key: sessionKey, sessionId: "context-instance", contextWeight: report }],
          },
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await gateway.waitForRequest("sessions.messages.subscribe");
      const draft = page
        .locator(".agent-chat__composer-combobox > textarea")
        .filter({ visible: true });
      await draft.fill("Keep this unsent draft");
      await page.locator(".context-ring").filter({ visible: true }).click();
      const summary = page.locator(".context-usage__popover").filter({ visible: true });
      const compactButton = summary.locator(".context-usage__actions .chat-context__compact");
      await summary.getByRole("button", { name: "Compact", exact: true }).waitFor();
      expect(await compactButton.getAttribute("class")).not.toContain(
        "chat-context__compact--high",
      );

      const beforeCompact = await gateway.deferNext("sessions.compact", { key: sessionKey });
      await compactButton.click();
      const compact = await gateway.waitForRequest("sessions.compact", {
        after: beforeCompact,
        match: { key: sessionKey },
      });
      expect(compact.params).toMatchObject({ key: sessionKey });
      const compacting = summary.getByRole("button", { name: "Compacting", exact: true });
      await compacting.waitFor();
      expect(await compacting.isDisabled()).toBe(true);
      expect(await draft.inputValue()).toBe("Keep this unsent draft");

      // The Gateway's compacted row is what the popover reports once the request settles.
      const compacted = { ...session, totalTokens: 21000, updatedAt: 2 };
      await gateway.setSessionsListResponse({ sessions: [compacted] });
      await gateway.resolveDeferred(
        "sessions.compact",
        { ok: true, compacted: true },
        { match: { key: sessionKey } },
      );
      await gateway.emitGatewayEvent("sessions.changed", {
        ...compacted,
        sessionKey,
        reason: "compact",
      });
      await expect
        .poll(() => summary.locator(".context-usage__context-value").textContent())
        .toContain("21%");
      await summary.getByRole("button", { name: "Compact", exact: true }).waitFor();
      expect(await summary.isVisible()).toBe(true);
      expect(await draft.inputValue()).toBe("Keep this unsent draft");
    });
  });

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
        featureMethods: [...defaultControlUiFeatureMethods, "sessions.usage"],
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
      await gateway.waitForRequest("sessions.messages.subscribe");
      const details = await openChatDetails(page);
      // Idle warmup may load presentation code; context data still waits for demand.
      expect(
        await page
          .locator(".context-usage__popover, openclaw-chat-context-panel")
          .filter({ visible: true })
          .count(),
      ).toBe(0);
      expect(await gateway.getRequests("sessions.usage")).toHaveLength(0);
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
      expect(await summary.getByRole("button", { name: "Refresh", exact: true }).count()).toBe(0);
      expect(await summary.getByRole("button", { name: "Compact", exact: true }).count()).toBe(1);
      expect(await summary.locator("button[data-context-category]").count()).toBe(0);
      const summarySegments = await summary
        .locator(".chat-context__segment")
        .evaluateAll((segments) => segments.map((segment) => segment.getAttribute("style")));
      expect(summarySegments).toHaveLength(5);
      await summary.getByRole("button", { name: "View context", exact: true }).click();
      await summary.waitFor({ state: "hidden" });
      const panel = page.locator("openclaw-chat-context-panel");
      const context = panel.locator(".chat-context-panel");
      await context.locator('[data-context-category="files"]').click();
      await context
        .locator('[data-context-section="files"] .chat-context__entry')
        .first()
        .waitFor();
      expect(await context.getByRole("meter").getAttribute("aria-valuenow")).toBe("50000");
      expect(await context.getByRole("meter").getAttribute("aria-valuemax")).toBe("100000");
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
      await context.locator('[title="/workspace/AGENTS.md"]').waitFor();
      expect(
        await context.locator('[data-context-section="files"] .chat-context__entry').count(),
      ).toBe(3);
      await context.getByText("Agent workspace", { exact: true }).waitFor();
      await context.getByText("Project · openclaw", { exact: true }).waitFor();
      await context.locator('[title="/projects/openclaw/AGENTS.md"]').waitFor();
      await context.locator('[data-context-details="deferred"]').waitFor();
      await context.getByRole("button", { name: "Compact", exact: true }).waitFor();
      await context.locator('[title="/workspace/AGENTS.md"]').scrollIntoViewIfNeeded();
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      await waitForControlUiFrameLayout([context]);
      expect(await context.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      await context.locator('[data-context-category="tools"]').click();
      expect(await context.locator('[data-context-section="files"]').count()).toBe(0);
      await context.getByText("System tools", { exact: true }).waitFor();
      await context
        .locator('[data-context-section="tools"]')
        .getByText("MCP tools · Docs", { exact: true })
        .waitFor();
      await context.locator('[data-context-category="skills"]').click();
      expect(await context.locator('[data-context-section="tools"]').count()).toBe(0);
      expect(
        await context.locator('[data-context-section="skills"] .chat-context__entry').count(),
      ).toBe(8);
      await context.getByRole("button", { name: "Show all 98", exact: true }).click();
      expect(
        await context.locator('[data-context-section="skills"] .chat-context__entry').count(),
      ).toBe(98);
      expect(
        await context
          .locator(".chat-context__accordion")
          .evaluateAll((lists) =>
            lists.every((list) => !["auto", "scroll"].includes(getComputedStyle(list).overflowY)),
          ),
      ).toBe(true);
      const finalSkill = context.getByText("project-skill-98", { exact: true });
      const header = context.locator(".chat-context-page__header");
      const headerTop = (await header.boundingBox())!.y;
      await finalSkill.scrollIntoViewIfNeeded();
      expect((await header.boundingBox())!.y).toBeCloseTo(headerTop, 0);
      expect(await finalSkill.isVisible()).toBe(true);
      expect(
        await context
          .locator(".chat-context-panel__scroll")
          .evaluate((element) => element.scrollTop),
      ).toBeGreaterThan(0);
      if (width > 900) {
        const sideHeader = page.locator('[data-region-header="side"]');
        await sideHeader.getByRole("button", { name: "New tab", exact: true }).click();
        await page.locator(".side-panel-launcher").waitFor();
        await sideHeader.getByRole("button", { name: "Close New tab", exact: true }).click();
        await finalSkill.waitFor();
        expect(
          await finalSkill.evaluate((element) => {
            const row = element.getBoundingClientRect();
            const viewport = element
              .closest(".chat-context-panel__scroll")!
              .getBoundingClientRect();
            return row.top >= viewport.top && row.bottom <= viewport.bottom;
          }),
        ).toBe(true);
      }
      await context.locator('[data-context-details="deferred"]').click();
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
        await context.getByRole("button", { name: "Compact", exact: true }).click();
        const compact = await gateway.waitForRequest("sessions.compact", {
          after: beforeCompact,
          match: { key: sessionKey },
        });
        expect(compact.params).toMatchObject({ key: sessionKey });
        const compacting = context.getByRole("button", { name: "Compacting", exact: true });
        await compacting.waitFor();
        expect(await compacting.isDisabled()).toBe(true);
        expect(await draft.inputValue()).toBe("Keep this unsent draft");
        await gateway.resolveDeferred(
          "sessions.compact",
          { ok: true, compacted: true },
          { match: { key: sessionKey } },
        );
        await context.getByRole("button", { name: "Compact", exact: true }).waitFor();
        expect(await draft.inputValue()).toBe("Keep this unsent draft");
        await gateway.setMethodResponse("sessions.usage", { sessions: [] });
        await context.getByRole("button", { name: "Refresh", exact: true }).click();
        await context.getByText("No matching context report.", { exact: false }).waitFor();
        expect(await context.getByRole("button", { name: "Refresh", exact: true }).count()).toBe(0);
        expect(await context.getByRole("button", { name: "Compact", exact: true }).count()).toBe(0);
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
        await gateway.emitGatewayEvent("sessions.changed", {
          sessionKey,
          key: sessionKey,
          sessionId: "context-instance",
          reason: "patch",
          model: "demo-model",
          modelProvider: "example",
          contextTokens: 100000,
          totalTokens: 50001,
          totalTokensFresh: true,
          updatedAt: 2,
        });
        await context.locator('[data-context-category="files"]').click();
        await context
          .locator('[data-context-section="files"] .chat-context__entry')
          .first()
          .waitFor();
        await context.locator('[title="Unverified"]').first().waitFor();
        await expect
          .poll(() => context.locator('[data-context-category="messages"]').textContent())
          .toContain("—");
        await page.setViewportSize({ width: 1440, height: 450 });
        await dockChatSidePanel(page, "bottom");
        await page.locator(".sidebar-region").evaluate(async (element) => {
          const animations = element
            .getAnimations({ subtree: true })
            .filter(
              (animation) =>
                animation.playState === "running" &&
                Number.isFinite(animation.effect?.getComputedTiming().endTime),
            );
          await Promise.all(
            animations.map((animation) => animation.finished.catch(() => undefined)),
          );
        });
        expect((await panel.boundingBox())!.height).toBeLessThanOrEqual(320);
        const deferred = context.locator('[data-context-details="deferred"]');
        await deferred.scrollIntoViewIfNeeded();
        const panelBounds = (await panel.boundingBox())!;
        const rowBounds = (await deferred.boundingBox())!;
        expect(rowBounds.y).toBeGreaterThanOrEqual(panelBounds.y);
        expect(rowBounds.y + rowBounds.height).toBeLessThanOrEqual(
          panelBounds.y + panelBounds.height,
        );
        expect((await header.boundingBox())!.y).toBeLessThan(panelBounds.y);
        await deferred.click();
        await context.getByText("search_docs", { exact: true }).waitFor();
      }
    });
  });
});
