import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  captureUiProof,
  captureUiProofEnabled,
  createSessionManagementE2eSuite,
  installMockGateway,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite(true);
const rows = ["main", "writer"].flatMap((agentId) =>
  Array.from({ length: 200 }, (_, index) =>
    createControlUiSessionRow(
      `agent:${agentId}:${index === 0 ? "main" : `dashboard:item-${index}`}`,
      `${agentId === "main" ? "Main" : "Writer"} project ${index}`,
      1_789_540_000_000 - index * 1_000,
      { agentId },
    ),
  ),
);

async function installAgentSwitchGateway(page: Page) {
  return installMockGateway(page, {
    sessions: rows,
    historyMessages: [{ role: "assistant", content: "Synthetic agent-switch conversation." }],
    methodResponses: {
      "agents.list": {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [
          { id: "main", name: "Main" },
          { id: "writer", name: "Writer" },
        ],
      },
    },
  });
}

async function switchAgent(page: Page, agentId: string): Promise<void> {
  const sidebar = page.locator("openclaw-app-sidebar");
  await sidebar.getByRole("button", { name: /Switch agent/ }).click();
  await sidebar.locator(`wa-dropdown-item[value="agent:${agentId}"]`).click();
}

function projectRow(page: Page, agentId: string) {
  return page
    .locator(`openclaw-app-sidebar [data-session-key="agent:${agentId}:dashboard:item-1"]`)
    .first();
}

suite.define(() => {
  it("shows selected rows before history and restores warm rows before the replacement list", async () => {
    await suite.withPage(
      {
        ...createControlUiE2eContextOptions(),
        ...(captureUiProofEnabled
          ? { recordVideo: { dir: suite.artifactDir, size: { width: 1280, height: 900 } } }
          : {}),
      },
      async ({ page }) => {
        const gateway = await installAgentSwitchGateway(page);
        await page.goto(`${suite.server.baseUrl}chat/main`);
        await projectRow(page, "main").waitFor();
        await captureUiProof(suite, page, "01-main-ready.png");
        await gateway.deferNext("chat.startup");
        await switchAgent(page, "writer");
        await gateway.waitForRequest("sessions.list", {
          match: { agentId: "writer", includeLastMessage: true },
        });
        await projectRow(page, "writer").waitFor();
        expect(await projectRow(page, "main").count()).toBe(0);
        await captureUiProof(suite, page, "02-writer-before-history.png");
        await gateway.resolveDeferred("chat.startup");

        // Hold the authoritative replacement: only correctly scoped loaded rows can appear.
        await gateway.deferNext("sessions.list", { agentId: "main", includeLastMessage: true });
        await switchAgent(page, "main");
        await expect
          .poll(
            async () =>
              (
                await gateway.getRequests("sessions.list", {
                  agentId: "main",
                  includeLastMessage: true,
                })
              ).length,
          )
          .toBe(2);
        await projectRow(page, "main").waitFor();
        expect(await projectRow(page, "writer").count()).toBe(0);
        await captureUiProof(suite, page, "03-main-before-replacement.png");
        await gateway.resolveDeferred("sessions.list");
        await projectRow(page, "main").waitFor();
        await captureUiProof(suite, page, "04-main-reconciled.png");
      },
    );
  });
});
