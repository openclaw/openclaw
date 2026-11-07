import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Create an agent chat group from the sidebar" });

suite.define(() => {
  it.each(["category", "none"])(
    "creates and reveals the first group from the toolbar with %s grouping",
    (grouping) =>
      suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 800 } },
        async ({ page }) => {
          await page.addInitScript(
            ({ key, initialGrouping }) => {
              localStorage.setItem(
                key,
                JSON.stringify({ sidebarAgentsMode: "chip", navWidth: 360 }),
              );
              localStorage.setItem("openclaw:sidebar:sessions:grouping", initialGrouping);
              localStorage.setItem("openclaw:sidebar:sessions:hide-empty-groups", "true");
            },
            {
              key: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
              initialGrouping: grouping,
            },
          );
          const gateway = await installMockGateway(page);
          await page.goto(`${suite.server.baseUrl}chat`);
          await page.locator(".agent-chat__composer-combobox textarea").waitFor();
          const sidebar = page.locator("openclaw-app-sidebar:visible");
          const surface = sidebar.locator("aside.sidebar");
          const toolbar = sidebar.locator(".sidebar-session-toolbar");
          await toolbar.waitFor();
          const entry = await takeControlUiScreenshotFrame(page, surface, [toolbar], {
            animations: "disabled",
            elements: [surface],
          });
          await writeFile(
            path.join(suite.artifactDir, `${grouping}-entry.png`),
            entry.elements[0]!.png,
          );
          const create = toolbar.getByRole("button", { name: "New group", exact: true });
          expect(await create.count()).toBe(1);
          await create.click();
          const dialog = page.getByRole("dialog", { name: "New group", exact: true });
          await dialog.getByRole("textbox").fill("Project Alpha");
          await dialog.getByRole("button", { name: "Create group", exact: true }).click();
          await dialog.waitFor({ state: "detached" });
          const group = sidebar.locator('[data-session-section="category:Project Alpha"]');
          await group.waitFor();
          const requests = await gateway.getRequests("sessions.groups.put");
          expect(requests).toHaveLength(1);
          expect(requests[0]?.params).toMatchObject({ names: ["Project Alpha"] });
          const created = await takeControlUiScreenshotFrame(page, surface, [toolbar, group], {
            animations: "disabled",
            elements: [surface],
          });
          await writeFile(
            path.join(suite.artifactDir, `${grouping}-created.png`),
            created.elements[0]!.png,
          );
          await group.locator(".sidebar-recent-sessions__head").hover();
          await group
            .getByRole("link", { name: "New session in Project Alpha", exact: true })
            .click();
          await expect.poll(() => page.url()).toContain("agent=main");
          await expect.poll(() => page.url()).toContain("group=Project+Alpha");
        },
      ),
  );
  it("offers no enabled creation before connection admission, then follows the admitted access", () =>
    suite.withPage({ locale: "en-US" }, async ({ page }) => {
      const gateway = await installMockGateway(page, { heldMethods: ["connect"] });
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("connect");
      expect(await page.locator(".sidebar-session-toolbar__new-group:enabled").count()).toBe(0);
      await gateway.resolveDeferred("connect");
      const create = page.locator(".sidebar-session-toolbar__new-group");
      await create.waitFor();
      await expect.poll(() => create.isDisabled()).toBe(false);
      expect(await gateway.getRequests("sessions.groups.put")).toHaveLength(0);
    }));

  it("disables creation when the connection has no write scope", () =>
    suite.withPage({ locale: "en-US" }, async ({ page }) => {
      const gateway = await installMockGateway(page, { operatorScopes: ["operator.read"] });
      await page.goto(`${suite.server.baseUrl}chat`);
      const create = page.locator(".sidebar-session-toolbar__new-group");
      await create.waitFor();
      expect(await create.isDisabled()).toBe(true);
      expect(await gateway.getRequests("sessions.groups.put")).toHaveLength(0);
    }));

  it("keeps a failed group save visible in its dialog without revealing a folder", () =>
    suite.withPage({ locale: "en-US" }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "sessions.groups.put": {
            __mockError: { code: "UNAVAILABLE", message: "Group save unavailable" },
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.locator(".sidebar-session-toolbar__new-group").click();
      const dialog = page.getByRole("dialog", { name: "New group", exact: true });
      await dialog.getByRole("textbox").fill("Project Alpha");
      await dialog.getByRole("button", { name: "Create group", exact: true }).click();
      const error = dialog.locator("form").getByRole("alert");
      await error.waitFor();
      expect(await error.textContent()).toBe("Group save unavailable");
      expect(await dialog.isVisible()).toBe(true);
      expect(await page.locator('[data-session-section="category:Project Alpha"]').count()).toBe(0);
      expect(await gateway.getRequests("sessions.groups.put")).toHaveLength(1);
    }));
});
