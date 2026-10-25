import { expect, it } from "vitest";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e-defaults.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createLightDesktopControlUiContextOptions } from "./control-ui-browser-options.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Chat header system information access" });

suite.define(() => {
  it.each([
    {
      scopes: ["operator.sessions.read", "operator.sessions.write"],
      revealLabel: null,
      systemReads: 0,
    },
    { scopes: ["operator.read"], revealLabel: null, systemReads: 1 },
    {
      scopes: ["operator.read", "operator.admin"],
      revealLabel: "Reveal in Finder",
      systemReads: 1,
    },
  ])("keeps the chat header usable with $scopes and gates platform reads", async (scenario) => {
    await suite.withPage(createLightDesktopControlUiContextOptions(), async ({ page }) => {
      const row = {
        ...createControlUiSessionRow("agent:main:platform-proof", "Scoped workspace", 1),
        spawnedCwd: "/workspace/scoped-proof",
      };
      const gateway = await installMockGateway(page, {
        communityInvite: false,
        sessionKey: row.key,
        sessions: [row],
        operatorScopes: scenario.scopes,
        featureMethods: [...defaultControlUiFeatureMethods, "system.info", "sessions.files.reveal"],
        methodResponses: {
          "system.info": scenario.systemReads
            ? { platform: "darwin" }
            : { __mockError: { code: "FORBIDDEN", message: "missing scope operator.read" } },
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, row.key));
      await gateway.waitForRequest("chat.startup");
      const pane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
      await pane.waitFor();
      await pane
        .getByText("Scoped workspace", { exact: true })
        .filter({ visible: true })
        .first()
        .waitFor();
      const workspace = pane.getByRole("button", {
        name: "Workspace actions for scoped-proof",
      });
      await workspace.click();
      const menu = pane.locator(".chat-pane__workspace-menu");
      await menu.getByRole("menuitem", { name: "Copy path" }).waitFor();
      if (scenario.systemReads) {
        await gateway.waitForRequest("system.info");
      }
      if (scenario.revealLabel) {
        await menu.getByRole("menuitem", { name: scenario.revealLabel }).waitFor();
      } else {
        expect(await menu.getByRole("menuitem", { name: /Reveal in /u }).count()).toBe(0);
      }
      expect(await gateway.getRequests("system.info")).toHaveLength(scenario.systemReads);
      expect(await page.getByText("missing scope operator.read").count()).toBe(0);
    });
  });
});
