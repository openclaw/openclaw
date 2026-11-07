import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
  controlUiSessionUrl,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { waitForSessionRosterHydration } from "./session-management.test-support.ts";
import { chooseSidebarOwner } from "./sidebar-session-menu.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Authorized project folders" });
const groups = ["Research", "Teaching", "Planning", "Reviews", "Settings"];

suite.define(() => {
  it("keeps authorized project folders through My sessions filtering and a full reload", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 800 } },
      async ({ page }) => {
        const viewer = { type: "human" as const, id: "viewer", label: "Viewer" };
        const agent = { type: "agent" as const, id: "main", label: "Assistant" };
        const own = sessionRow("agent:main:mine", "My conversation", 100, {
          owner: { actor: viewer },
          model: "test-model",
        });
        const other = Array.from({ length: 4 }, (_, i) =>
          sessionRow(`agent:main:other-${i}`, `Agent conversation ${i}`, 100, {
            owner: { actor: agent },
            model: "test-model",
            category: groups[0],
          }),
        );
        await page.addInitScript(
          ({ key }) => {
            if (!localStorage.getItem(key)) {
              localStorage.setItem(
                key,
                JSON.stringify({ sidebarAgentsMode: "chip", navWidth: 360 }),
              );
            }
          },
          { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl) },
        );
        const gateway = await installMockGateway(page, {
          authMethod: "trusted-proxy",
          authMode: "trusted-proxy",
          agentModel: "openai/test-model",
          models: [{ id: "test-model", name: "Test model", provider: "openai" }],
          sessions: [own, ...other],
          sessionKey: own.key,
          sessionGroups: groups,
          presenceUsers: [{ id: viewer.id, name: viewer.label, self: true }],
          heldMethods: ["connect"],
          methodResponses: {
            "sessions.list": {
              ts: 100,
              path: "",
              count: 5,
              sessions: [own, ...other],
              defaults: {},
              owners: [viewer, agent],
            },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, own.key, "chat"));
        await gateway.waitForRequest("connect");
        await gateway.resolveDeferred("connect");
        const sidebar = page.locator("openclaw-app-sidebar");
        await sidebar.locator("#sidebar-session-owner-title").waitFor();
        await chooseSidebarOwner(page, "all");
        await sidebar.locator('[data-session-key="agent:main:other-0"]').waitFor();
        await chooseSidebarOwner(page, "owner:viewer");
        await expect
          .poll(() => sidebar.locator('[data-session-key="agent:main:other-0"]').count())
          .toBe(0);
        await sidebar.locator('[data-session-key="agent:main:mine"]').waitFor();
        const sidebarFrame = await takeControlUiScreenshotFrame(
          page,
          page.locator("aside.sidebar"),
          [],
          {
            animations: "disabled",
            elements: [page.locator("aside.sidebar")],
          },
        );
        await writeFile(
          path.join(suite.artifactDir, "my-sessions-project-folders.png"),
          sidebarFrame.elements[0]!.png,
        );
        for (const group of groups) {
          expect(await sidebar.locator(`[data-session-section="category:${group}"]`).count()).toBe(
            1,
          );
        }
        await page.reload();
        await gateway.waitForRequest("connect");
        await gateway.resolveDeferred("connect");
        await page.locator(".agent-chat__composer-combobox textarea").waitFor();
        await waitForSessionRosterHydration(page);
        await page.locator('aside.sidebar[data-snapshot-state="live"]').waitFor();
        await sidebar.locator('[data-session-key="agent:main:mine"]').waitFor();
        for (const group of groups) {
          expect(await sidebar.locator(`[data-session-section="category:${group}"]`).count()).toBe(
            1,
          );
        }
        expect(await sidebar.locator('[data-session-key="agent:main:other-0"]').count()).toBe(0);
      },
    );
  });
});
