import { expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { createControlUiSessionRow as row } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  createSessionManagementE2eSuite,
  installMockGateway,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite(true);
suite.define(() => {
  it("opens a folder, uses the existing personal pin owner, and moves only the thread category", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const key = "agent:main:folder-review";
      const gateway = await installMockGateway(page, {
        sessionKey: key,
        sessionGroups: ["Release", "Research"],
        sessions: [row(key, "Release review", Date.now(), { category: "Release", status: "done" })],
        methodResponses: {
          "progressCard.get": {
            card: {
              sessionKey: key,
              revision: 1,
              updatedAt: Date.now(),
              markdown: "Tests passed. Human review still needed.",
            },
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}sessions?folder=Release`);
      const folder = page.locator(".session-folders");
      await folder.getByRole("link", { name: "Release review", exact: true }).waitFor();
      await folder.getByRole("button", { name: "Pin for me", exact: true }).click();
      await expect
        .poll(() =>
          evaluateControlUiContext(page, (context) => context.navigation.snapshot.sidebarEntries),
        )
        .toContain(`session:${key}`);
      await folder.getByText("Tests passed. Human review still needed.").waitFor();
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
      await folder
        .getByRole("combobox", { name: "Move Release review to folder" })
        .selectOption("Research");
      const moved = await gateway.waitForRequest("sessions.patch", {
        match: { key, category: "Research" },
      });
      expect(moved.params).not.toHaveProperty("visibility");
      expect(moved.params).not.toHaveProperty("owner");
      await expect.poll(() => folder.locator("[data-folder-thread]").count()).toBe(0);
      await folder.getByRole("button", { name: "← Folders" }).click();
      await folder.getByRole("button", { name: /Research/ }).click();
      await folder.getByRole("link", { name: "Release review", exact: true }).first().waitFor();
      await folder.getByRole("link", { name: "Release review", exact: true }).first().click();
      await page.locator("openclaw-chat-page").waitFor();
    });
  });
});
