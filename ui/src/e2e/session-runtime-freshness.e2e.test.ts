import path from "node:path";
import { expect, it } from "vitest";
import type { AppSidebarSessionNavigationElement } from "../components/app-sidebar-session-navigation.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  chatSessionListResponse,
  controlUiSessionUrl,
  installMockGateway,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Session runtime freshness" });

suite.define(() => {
  it("keeps an unopened thread's spinner through an older cached list response", async () => {
    const artifactDir = createControlUiE2eArtifactDir("session-runtime-freshness");
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const now = Date.now();
      const selected = createControlUiSessionRow("agent:main:planning", "Planning desk", now, {
        model: "gpt-4o",
      });
      const background = createControlUiSessionRow(
        "agent:main:background",
        "Background verification",
        now - 1_000,
        { snapshotAt: now - 100, activeRunIds: [], model: "gpt-4o" },
      );
      const gateway = await installMockGateway(page, {
        agentModel: "openai/gpt-4o",
        sessionKey: selected.key,
        sessions: [selected, background],
        historyMessages: [
          {
            role: "assistant",
            content: "The background task can run while this thread stays open.",
          },
        ],
        methodResponses: {
          "sessions.list": {
            ...chatSessionListResponse([selected, background]),
            defaults: { contextTokens: null, model: "gpt-4o", modelProvider: "openai" },
          },
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, selected.key));
      const sidebar = page.locator("openclaw-app-sidebar");
      const row = sidebar.locator(`.sidebar-recent-session[data-session-key="${background.key}"]`);
      const spinner = row.locator(".session-glyph__ring");
      await row.waitFor();
      expect(await spinner.count()).toBe(0);
      await gateway.emitGatewayEvent("sessions.changed", {
        agentId: "main",
        reason: "run-capacity",
        session: {
          ...background,
          snapshotAt: now,
          status: "running",
          hasActiveRun: true,
          activeRunIds: ["background-run"],
        },
        ancestorSessions: [],
        ts: now,
      });
      await spinner.waitFor();
      const previousReads = (await gateway.getRequests("sessions.list")).length;
      await sidebar.evaluate(async (element) => {
        const host = element as AppSidebarSessionNavigationElement;
        await host.sessionData.refreshSidebarSessions();
        await host.updateComplete;
      });
      expect((await gateway.getRequests("sessions.list")).length).toBeGreaterThan(previousReads);
      // Capture the original missing-spinner failure and the repaired state at
      // the identical boundary, before an assertion can retire the browser.
      await page.screenshot({ path: path.join(artifactDir, "after-cached-list.png") });
      expect(await spinner.count()).toBe(1);
      expect(
        await sidebar.locator(".sidebar-recent-session--active").getAttribute("data-session-key"),
      ).toBe(selected.key);
    });
  });
});
