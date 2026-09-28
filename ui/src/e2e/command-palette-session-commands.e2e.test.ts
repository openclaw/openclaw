import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
  waitForPatch,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it("renames and archives the open session from the command palette", async () => {
    const artifacts = createControlUiE2eArtifactDir("command-palette-session-commands");
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const main = sessionRow("agent:main:main", "Main", 1);
    const target = sessionRow("agent:main:palette-target", "Lisbon trip planning", 2);
    const gateway = await installMockGateway(page, {
      methodResponses: { "sessions.list": sessionsListResponse([main, target]) },
      sessionArchiveFiltering: true,
      sessionKey: target.key,
    });
    const input = page.locator(".cmd-palette__input");
    const runFromPalette = async (query: string, label: string) => {
      await page.keyboard.press("ControlOrMeta+K");
      await input.fill(query);
      const option = page.getByRole("option", { name: label, exact: true });
      await option.waitFor({ state: "visible" });
      await page.screenshot({ path: `${artifacts}/palette-${query}.png` });
      await input.press("Enter");
      await input.waitFor({ state: "detached" });
    };
    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, target.key));
      await page
        .locator(`.sidebar-recent-session[data-session-key="${target.key}"]`)
        .waitFor({ state: "visible" });

      await runFromPalette("rename", "Rename session");
      // The closed palette returned focus before the header took it for editing.
      const title = page.locator(".chat-pane__session-title-input");
      await expect.poll(() => title.evaluate((node) => node === document.activeElement)).toBe(true);
      await title.fill("Lisbon itinerary");
      await title.press("Enter");
      const renamed = await waitForPatch(gateway, (params) => params.label === "Lisbon itinerary");
      expect(renamed.params).toMatchObject({ key: target.key });

      await runFromPalette("archive", "Archive session");
      const archived = await waitForPatch(
        gateway,
        (params) => params.key === target.key && params.archived === true,
      );
      expect(archived.params).toMatchObject({ expectedSessionId: target.sessionId });
      await page.getByRole("button", { name: "Undo", exact: true }).waitFor({ state: "visible" });
      await page.screenshot({ path: `${artifacts}/archived.png` });
    } finally {
      await context.close();
    }
  });
});
