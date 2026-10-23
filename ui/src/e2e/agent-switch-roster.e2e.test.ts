import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { agentRoster } from "./agent-roster.test-support.ts";
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

async function switchAgent(page: Page, agentId: string): Promise<void> {
  const sidebar = page.locator("openclaw-app-sidebar");
  await sidebar.getByRole("button", { name: /Switch agent/ }).click();
  await sidebar.locator(`[data-value="agent:${agentId}"]`).click();
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
        const gateway = await installMockGateway(page, {
          sessions: rows,
          historyMessages: [{ role: "assistant", content: "Synthetic agent-switch conversation." }],
          methodResponses: {
            "agents.list": agentRoster({ main: "Main", writer: "Writer" }, "main", "per-sender"),
          },
        });
        await page.goto(`${suite.server.baseUrl}chat/main`);
        await projectRow(page, "main").waitFor();
        await captureUiProof(suite, page, "01-main-ready.png");
        const startupRequests = await gateway.deferNext("chat.startup");
        await switchAgent(page, "writer");
        await gateway.waitForRequest("sessions.list", {
          match: { agentId: "writer", includeLastMessage: true },
        });
        await projectRow(page, "writer").waitFor();
        expect(await projectRow(page, "main").count()).toBe(0);
        await captureUiProof(suite, page, "02-writer-before-history.png");
        await gateway.waitForRequest("chat.startup", { after: startupRequests });
        await gateway.resolveDeferred("chat.startup");

        // Hold the authoritative replacement: only correctly scoped loaded rows can appear.
        const mainQuery = { agentId: "main", includeLastMessage: true };
        await gateway.deferNext("sessions.list", mainQuery);
        await switchAgent(page, "main");
        await expect
          .poll(async () => (await gateway.getRequests("sessions.list", mainQuery)).length)
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
