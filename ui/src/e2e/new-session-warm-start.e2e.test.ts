import { expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import {
  createControlUiMockBootstrapConfig,
  createControlUiMockSameOriginGatewayScript,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { sessionsListResponse } from "./session-management.test-support.ts";

const suite = createControlUiE2eSuite({ name: "New Session warm startup" });

suite.define(() => {
  it("retains saved sidebar rows while hello awaits the profile and reads only bootstrap display config", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" },
      async ({ page }) => {
        const profile = { id: "warm-operator", displayName: "Warm operator", emails: [] };
        const rows = [
          createControlUiSessionRow(
            "agent:main:warm-retained",
            "Retained conversation",
            Date.now(),
            {
              owner: { actor: { type: "human", id: profile.id, label: profile.displayName } },
            },
          ),
        ];
        const displayConfig = { ui: { prefs: { themeMode: "dark" } } };
        const scenario = {
          authMethod: "trusted-proxy" as const,
          authMode: "trusted-proxy" as const,
          awaitInitialRoster: false,
          heldMethods: ["connect"],
          presenceUsers: [],
          sessions: rows,
          methodResponses: {
            "users.self": { profile },
            "sessions.list": sessionsListResponse(rows),
          },
        };
        await page.addInitScript({ content: createControlUiMockSameOriginGatewayScript() });
        const gateway = await installMockGateway(page, scenario);
        const bootstrap = {
          ...createControlUiMockBootstrapConfig(scenario),
          preferences: { profileId: profile.id, config: displayConfig, entries: {} },
        };
        await page.route("**/control-ui-config.json", (route) =>
          route.fulfill({ json: bootstrap }),
        );
        await page.goto(`${suite.server.baseUrl}new?agent=main`);
        await gateway.waitForRequest("connect");
        await gateway.resolveDeferred("connect");
        const sidebar = page.locator("aside.sidebar");
        const row = sidebar.locator('[data-session-key="agent:main:warm-retained"]');
        await row.waitFor({ state: "visible" });
        await page.locator('aside.sidebar[data-snapshot-saved="true"]').waitFor();
        await expect
          .poll(() =>
            page.evaluate(() =>
              Object.keys(localStorage).some(
                (key) =>
                  key.startsWith("openclaw.control.bootRecord.v1:") &&
                  JSON.parse(localStorage.getItem(key) ?? "{}").recoveryScope ===
                    "e2e-recovery-scope",
              ),
            ),
          )
          .toBe(true);

        await page.reload();
        await gateway.waitForRequest("connect");
        await page.locator('aside.sidebar[data-snapshot-state="cached"]').waitFor();
        await row.waitFor({ state: "visible" });
        await gateway.deferNext("users.self");
        await gateway.deferNext("sessions.list");
        await gateway.resolveDeferred("connect");
        await gateway.waitForRequest("users.self");
        await gateway.waitForRequest("sessions.list");
        // An unresolved profile is not a new profileless identity. The accepted
        // recovery scope still owns the disabled, cached sidebar presentation.
        expect(await sidebar.getAttribute("data-snapshot-state")).toBe("cached");
        expect(await row.isVisible()).toBe(true);
        expect(await gateway.getRequests("config.get")).toHaveLength(0);
        await gateway.resolveDeferred("users.self");
        expect(await row.isVisible()).toBe(true);
        await gateway.resolveDeferred("sessions.list");
        await page.locator('aside.sidebar[data-snapshot-state="live"]').waitFor();
        await row.waitFor({ state: "visible" });
        await expect
          .poll(() =>
            evaluateControlUiContext(page, (app) => app.runtimeConfig.state.bootstrapConfig),
          )
          .toEqual(displayConfig);
        expect(await gateway.getRequests("config.get")).toHaveLength(0);
        expect(await gateway.getRequests("sessions.list")).toHaveLength(1);
      },
    );
  });
});
