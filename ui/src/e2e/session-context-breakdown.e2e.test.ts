import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { SessionSystemPromptReport } from "../../../src/config/sessions/session-system-prompt-report.js";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Sidebar context breakdown" });
const sessionKey = "agent:main:context-breakdown";
const report: SessionSystemPromptReport = {
  source: "run",
  generatedAt: 1,
  sessionId: "context-instance",
  sessionKey,
  systemPrompt: { chars: 40000, projectContextChars: 16000, nonProjectContextChars: 24000 },
  injectedWorkspaceFiles: [
    {
      name: "AGENTS.md",
      path: "/workspace/AGENTS.md",
      missing: false,
      rawChars: 12000,
      injectedChars: 12000,
      truncated: false,
    },
    {
      name: "USER.md",
      path: "/workspace/USER.md",
      missing: false,
      rawChars: 4000,
      injectedChars: 4000,
      truncated: false,
    },
  ],
  skills: { promptChars: 8000, entries: [{ name: "code-review", blockChars: 8000 }] },
  tools: {
    listChars: 0,
    schemaChars: 12000,
    entries: [{ name: "exec", summaryChars: 800, schemaChars: 12000 }],
  },
};

suite.define(() => {
  it.each([
    { width: 1440, height: 1000, mode: "dark" as const },
    { width: 390, height: 844, mode: "light" as const },
  ])("shows a scoped, non-overlapping breakdown ($width px)", async ({ width, height, mode }) => {
    await suite.withPage({ viewport: { width, height }, colorScheme: mode }, async ({ page }) => {
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
      if (width <= 900) {
        await page.locator(".chat-header-session-menu__trigger").click();
        await page.getByRole("menuitem", { name: "Session details", exact: true }).click();
      } else {
        await page.getByRole("button", { name: "Details", exact: true }).click();
      }
      const panel = page.locator(".chat-details");
      const context = panel.locator(".chat-details__context");
      await context.locator(":scope > summary").click();
      const initial = await takeControlUiScreenshotFrame(page, panel, [context], {
        elements: [panel],
        animations: "disabled",
      });
      await writeFile(
        path.join(suite.artifactDir, "context-initial-" + width + ".png"),
        initial.png,
      );
      await writeFile(
        path.join(suite.artifactDir, "context-initial-" + width + "-panel.png"),
        initial.elements[0]!.png,
      );
      await context.getByText("Workspace memory", { exact: true }).waitFor();
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
      await context.getByText("AGENTS.md", { exact: true }).waitFor();
      await context.getByRole("button", { name: "Compact session", exact: true }).waitFor();
      const after = await takeControlUiScreenshotFrame(
        page,
        panel,
        [context.getByText("AGENTS.md", { exact: true })],
        { elements: [panel], animations: "disabled" },
      );
      await writeFile(
        path.join(suite.artifactDir, "context-expanded-" + width + ".png"),
        after.png,
      );
      await writeFile(
        path.join(suite.artifactDir, "context-expanded-" + width + "-panel.png"),
        after.elements[0]!.png,
      );
      expect(await context.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
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
        const unavailable = await takeControlUiScreenshotFrame(page, panel, [context], {
          elements: [panel],
          animations: "disabled",
        });
        await writeFile(
          path.join(suite.artifactDir, "context-unavailable-panel.png"),
          unavailable.elements[0]!.png,
        );
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
        await context.getByText("Workspace memory", { exact: true }).waitFor();
        await context.locator('[data-context-details="files"] > summary').click();
        await context.getByText("Unverified", { exact: true }).waitFor();
        await expect
          .poll(() => context.locator('[data-context-category="messages"]').textContent())
          .toContain("—");
        const unknown = await takeControlUiScreenshotFrame(
          page,
          panel,
          [context.getByText("Unverified", { exact: true })],
          {
            elements: [panel],
            animations: "disabled",
          },
        );
        await writeFile(
          path.join(suite.artifactDir, "context-unverified-panel.png"),
          unknown.elements[0]!.png,
        );
      }
    });
  });
});
