import path from "node:path";
import { expect, it } from "vitest";
import type { SessionCatalog } from "../../../packages/gateway-protocol/src/index.ts";
import type { AppSidebarSessionNavigationElement } from "../components/app-sidebar-session-navigation.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Pending paired-node catalog",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("keeps the paired-node row through pending refresh and applies its later publication", async () => {
    const artifactDir = createControlUiE2eArtifactDir("session-catalog-pending-host");
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const catalog: SessionCatalog = {
        id: "codex",
        label: "Codex",
        capabilities: { continueSession: false, archive: false },
        hosts: [
          {
            hostId: "node:devbox",
            label: "Dev Box",
            kind: "node",
            connected: true,
            sessions: [
              {
                threadId: "release-review",
                name: "Paired node release review",
                status: "stored",
                archived: false,
                canContinue: false,
                canArchive: false,
              },
            ],
          },
        ],
      };
      const gateway = await installMockGateway(page, {
        featureMethods: ["chat.metadata", "chat.startup", "sessions.catalog.list"],
        methodResponses: { "sessions.catalog.list": { catalogs: [catalog] } },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      const sidebar = page.locator("openclaw-app-sidebar");
      const heldRow = sidebar.getByText("Paired node release review", { exact: true });
      await heldRow.waitFor();
      const pendingCatalog = {
        ...catalog,
        hosts: [{ ...catalog.hosts[0]!, sessions: [], pending: true }],
      };
      await gateway.setMethodResponse("sessions.catalog.list", { catalogs: [pendingCatalog] });
      await sidebar.evaluate(async (element) => {
        const sidebarElement = element as AppSidebarSessionNavigationElement;
        await sidebarElement.sessionData.refreshSessionCatalogs();
        await sidebarElement.updateComplete;
      });
      const request = (await gateway.getRequests("sessions.catalog.list")).at(-1)!;
      // Capture before the assertion so the original row-clearing regression has visual evidence.
      await page.screenshot({ path: path.join(artifactDir, "pending-node.png") });
      expect(await heldRow.count()).toBe(1);
      expect(request.params).toMatchObject({
        allowPartialResults: true,
        progressId: expect.any(String),
      });

      await gateway.emitGatewayEvent("sessions.catalog.host", {
        progressId: (request.params as { progressId: string }).progressId,
        agentId: "main",
        catalog: {
          ...catalog,
          hosts: [
            {
              ...catalog.hosts[0]!,
              sessions: [
                { ...catalog.hosts[0]!.sessions[0]!, name: "Paired node review refreshed" },
              ],
            },
          ],
        },
      });
      await sidebar.getByText("Paired node review refreshed", { exact: true }).waitFor();
      expect(await heldRow.count()).toBe(0);
      await page.screenshot({ path: path.join(artifactDir, "refreshed-node.png") });
    });
  });
});
