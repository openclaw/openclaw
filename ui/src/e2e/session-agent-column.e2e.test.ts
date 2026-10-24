import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI session agent column" });
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

async function selectAgentScope(page: Page, name: string) {
  const control = page.locator(".sessions-hub-header .agent-scope-control openclaw-agent-select");
  await control.locator(".agent-select__trigger").click();
  await control
    .locator(".agent-select__option[data-agent-option]")
    .filter({ hasText: name })
    .evaluate((option) => (option as HTMLElement).click());
  await page.locator(".agent-select__menu").waitFor({ state: "hidden" });
}

suite.define(() => {
  it.each([1440, 390])(
    "shows Agent only in the all-agent sessions table at %i px",
    async (width) => {
      await suite.withPage({ viewport: { width, height: 900 } }, async ({ page }) => {
        await installMockGateway(page, {
          sessionKey: "unknown",
          methodResponses: {
            "agents.list": {
              defaultId: "main",
              mainKey: "main",
              scope: "per-sender",
              agents: [
                { id: "main", name: "Assistant" },
                { id: "research", name: "Research" },
              ],
            },
            "sessions.list": {
              count: 2,
              defaults: { contextTokens: null, model: null, modelProvider: null },
              path: "",
              sessions: [
                { key: "agent:main:main", kind: "direct", label: "Planning", updatedAt: 2 },
                { key: "agent:research:brief", kind: "direct", label: "Brief", updatedAt: 1 },
              ],
              ts: 3,
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}sessions`);
        const table = page.locator(".sessions-table");
        await table.locator(".session-data-row").first().waitFor();

        await selectAgentScope(page, "Assistant");
        await expect
          .poll(() => table.locator("thead th").allTextContents())
          .toEqual(["", "Session", "Updated", "Actions"]);
        expect(await table.locator(".session-data-row .agent-row-chip").count()).toBe(0);
        if (captureUiProof) {
          await writeFile(
            path.join(suite.artifactDir, `sessions-agent-scoped-${width}.png`),
            await takeControlUiViewportScreenshot(page, page.locator(".shell"), [table]),
          );
        }

        await selectAgentScope(page, "All agents");
        await expect
          .poll(() => table.locator("thead th").allTextContents())
          .toEqual(["", "Session", "Agent", "Updated", "Actions"]);
        await expect
          .poll(() => table.locator(".session-agent-col .agent-row-chip").count())
          .toBe(2);
        expect(await table.locator(".session-agent-col [data-agent-id='research']").count()).toBe(
          1,
        );
        expect(await table.locator(".session-key-cell .agent-row-chip").count()).toBe(0);
        if (captureUiProof) {
          await writeFile(
            path.join(suite.artifactDir, `sessions-all-agents-${width}.png`),
            await takeControlUiViewportScreenshot(page, page.locator(".shell"), [table]),
          );
        }
      });
    },
  );
});
