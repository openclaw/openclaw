import path from "node:path";
import { expect, it } from "vitest";
import type { SessionDataController } from "../components/session-data-controller.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Sidebar catalog scope" });

suite.define(() => {
  it("discovers and opens ordinary guest sessions without requesting the external catalog", async () => {
    const artifactDir = createControlUiE2eArtifactDir("sidebar-catalog-scope");
    const viewport = { width: 1440, height: 900 };
    const context = await suite.newBrowserContext({
      viewport,
      recordVideo: { dir: artifactDir, size: viewport },
    });
    const page = await context.newPage();
    try {
      const key = "agent:main:visitor-notes";
      const gateway = await installMockGateway(page, {
        sessionKey: key,
        operatorScopes: ["operator.sessions.write"],
        featureMethods: [...defaultControlUiFeatureMethods, "sessions.catalog.list"],
        sessions: [createControlUiSessionRow(key, "Visitor notes", Date.now())],
        historyMessages: [
          { role: "assistant", content: [{ type: "text", text: "Welcome back." }] },
        ],
        methodResponses: {
          "sessions.catalog.list": {
            __mockError: { code: "INVALID_REQUEST", message: "missing scope: operator.read" },
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      const sidebar = page.locator("openclaw-app-sidebar");
      const session = sidebar.locator(`[data-session-key="${key}"]`).first();
      await session.waitFor({ state: "visible" });
      await page.waitForFunction(() => {
        const data = document.querySelector<HTMLElement & { sessionData: SessionDataController }>(
          "openclaw-app-sidebar",
        )?.sessionData;
        return (
          data &&
          (data.sessionCatalogAgentId === null ||
            data.sessionCatalogRefreshStatus.error !== null ||
            data.sessionCatalogRefreshStatus.hasLoaded)
        );
      });
      await page.screenshot({ path: path.join(artifactDir, "sidebar.png") });
      expect((await gateway.getRequests("sessions.list")).length).toBeGreaterThan(0);
      expect(await gateway.getRequests("sessions.catalog.list")).toEqual([]);
      expect(await sidebar.getByRole("alert").count()).toBe(0);
      await session.click();
      await page.getByText("Welcome back.", { exact: true }).waitFor();
      expect(await gateway.getRequests("sessions.catalog.list")).toEqual([]);
      expect(await sidebar.getByRole("alert").count()).toBe(0);
      await page.screenshot({ path: path.join(artifactDir, "opened-session.png") });
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
