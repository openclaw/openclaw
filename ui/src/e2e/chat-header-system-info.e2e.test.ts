import path from "node:path";
import { expect, it } from "vitest";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e-defaults.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Chat header system information access" });

suite.define(() => {
  it.each([
    {
      name: "session-only",
      scopes: ["operator.sessions.read", "operator.sessions.write"],
      revealLabel: null,
      systemReads: 0,
    },
    {
      name: "operator read only",
      scopes: ["operator.read"],
      revealLabel: null,
      systemReads: 1,
    },
    {
      name: "operator read and admin",
      scopes: ["operator.read", "operator.admin"],
      revealLabel: "Reveal in Finder",
      systemReads: 1,
    },
  ])(
    "keeps the chat header usable with $name scopes and gates platform reads",
    async (scenario) => {
      await suite.withPage(
        {
          colorScheme: "light",
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 800, width: 1180 },
        },
        async ({ page }) => {
          const row = {
            ...createControlUiSessionRow("agent:main:platform-proof", "Scoped workspace", 1),
            spawnedCwd: "/workspace/scoped-proof",
          };
          const gateway = await installMockGateway(page, {
            communityInvite: false,
            sessionKey: row.key,
            sessions: [row],
            operatorScopes: scenario.scopes,
            featureMethods: [
              ...defaultControlUiFeatureMethods,
              "system.info",
              "sessions.files.reveal",
            ],
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
          await pane.getByText("Scoped workspace", { exact: true }).first().waitFor();
          const workspace = pane.getByRole("button", {
            name: "Workspace actions for scoped-proof",
          });
          await workspace.click();
          const menu = pane.locator(".chat-pane__workspace-menu");
          await menu.getByRole("menuitem", { name: "Copy path" }).waitFor();
          if (scenario.systemReads) {
            await gateway.waitForRequest("system.info");
            await expect
              .poll(() =>
                pane.evaluate(
                  (element) =>
                    (element as HTMLElement & { headerPlatform?: string | null }).headerPlatform,
                ),
              )
              .toBe("darwin");
          }
          if (scenario.revealLabel) {
            await menu.getByRole("menuitem", { name: scenario.revealLabel }).waitFor();
          } else {
            expect(await menu.getByRole("menuitem", { name: /Reveal in /u }).count()).toBe(0);
          }
          const systemRequests = await gateway.getRequests("system.info");
          expect(systemRequests).toHaveLength(scenario.systemReads);
          console.info("[chat-header-scope]", {
            scope: scenario.name,
            systemInfoRequests: systemRequests.length,
            workspaceAction: scenario.revealLabel ?? "Copy path (no reveal access)",
          });
          expect(await page.getByText("missing scope operator.read").count()).toBe(0);
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
            await page.screenshot({
              path: path.join(
                suite.artifactDir,
                `chat-header-${scenario.name.replaceAll(" ", "-")}.png`,
              ),
              animations: "disabled",
            });
          }
        },
      );
    },
  );
});
