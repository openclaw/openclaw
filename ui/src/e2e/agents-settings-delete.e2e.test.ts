import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e-defaults.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  installMockGateway,
  startControlUiE2eServer,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Agents settings deletion",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
});

suite.define(() => {
  it.each([1440, 390])(
    "deletes the selected agent through the settings menu at %ipx",
    async (width) => {
      await suite.withPage(
        { viewport: { width, height: 900 }, reducedMotion: "reduce", serviceWorkers: "block" },
        async ({ page }) => {
          const roster = {
            defaultId: "main",
            mainKey: "main",
            scope: "per-sender",
            agents: [
              { id: "main", name: "Anchor", identity: { name: "Anchor", emoji: "⚓" } },
              { id: "research", name: "Research", identity: { name: "Research", emoji: "🔬" } },
            ],
          };
          const gateway = await installMockGateway(page, {
            featureMethods: [...defaultControlUiFeatureMethods, "agents.delete"],
            assistantName: "Anchor",
            agentModel: "fixture/synthetic",
            models: [{ id: "synthetic", name: "Synthetic model", provider: "fixture" }],
            methodResponses: { "agents.list": roster },
          });
          await page.goto(`${suite.server.baseUrl}settings/agents/research`);
          await waitForControlUiRoute(page, {
            routeId: "agents",
            pathname: "/settings/agents/research",
          });
          await page.locator(".agents-page-menu__trigger:visible").click();
          const copy = page.getByRole("menuitem", { name: "Copy ID", exact: true });
          await copy.waitFor();
          const frame = await takeControlUiScreenshotFrame(
            page,
            page.locator(".agents-page-menu:visible"),
            [copy],
            { animations: "disabled" },
          );
          await writeFile(path.join(suite.artifactDir, `menu-${width}.png`), frame.png);
          const deletion = page.getByRole("menuitem", { name: "Delete", exact: true });
          expect(await deletion.count()).toBe(1);
          await deletion.click();
          const dialog = page.getByRole("dialog");
          await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
          expect(await gateway.getRequests("agents.delete")).toHaveLength(0);
          await page.locator(".agents-page-menu__trigger:visible").click();
          await deletion.click();
          await dialog.getByRole("button", { name: "Delete", exact: true }).click();
          await gateway.waitForRequest("agents.delete", {
            match: { agentId: "research", deleteFiles: true },
          });
          await gateway.waitForRequest("agents.list", { after: 1 });
        },
      );
    },
  );
});
