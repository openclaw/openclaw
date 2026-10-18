import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiTeamScaleFixture,
  TEAM_SCALE_SELF_INSTANCE_ID,
} from "../test-helpers/control-ui-team-scale-fixture.ts";
import { useCanvasSandboxFixture } from "./canvas-sandbox.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { selectAllSidebarSessions } from "./sidebar-navigation.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Team-scale cold-load fixture" });

suite.define(() => {
  const sandbox = useCanvasSandboxFixture();

  it("loads a paged Team roster, off-page pins, plugins, and inline widgets through a deep link", async () => {
    const fixture = createControlUiTeamScaleFixture({
      baseUrl: suite.server.baseUrl,
      ...sandbox(""),
    });
    await suite.withPage(
      {
        locale: "en-US",
        viewport: { width: 1440, height: 1000 },
        serviceWorkers: "block",
        permissions: ["local-network-access"],
      },
      async ({ page }) => {
        await page.route("**/__openclaw__/**", async (route) => {
          const asset = fixture.assets.get(new URL(route.request().url()).pathname);
          if (asset) {
            await route.fulfill({ status: 200, ...asset });
          } else {
            await route.fallback();
          }
        });
        await page.addInitScript(
          ({ key, entries }) => {
            if (window !== window.top) {
              return;
            }
            localStorage.setItem(
              key,
              JSON.stringify({
                sidebarAgentsMode: "roster",
                railShortcuts: entries,
                navigationByProfile: { "team-person-001": { railShortcuts: entries } },
              }),
            );
          },
          {
            key: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
            entries: fixture.sidebarEntries,
          },
        );
        const gateway = await installMockGateway(page, fixture.scenario);
        await page.goto(
          controlUiSessionUrl(suite.server.baseUrl, fixture.selectedSessionKey, "dashboard"),
        );
        await page
          .locator(".chat-pane__session-title-text", { hasText: "Project dashboard 1" })
          .waitFor();

        await selectAllSidebarSessions(page);
        const catalogRequest = await gateway.waitForRequest("sessions.catalog.list");
        const progressId = asRecord(catalogRequest.params)?.progressId;
        expect(typeof progressId).toBe("string");
        const connectRequest = await gateway.waitForRequest("connect");
        const instanceId = asRecord(asRecord(connectRequest.params)?.client)?.instanceId;
        expect(typeof instanceId).toBe("string");
        for (const frame of fixture.events) {
          await gateway.emitGatewayEvent(
            frame.event,
            frame.event === "sessions.catalog.host"
              ? { ...frame.payload, progressId }
              : {
                  presence: frame.payload.presence.map((entry) =>
                    Object.assign({}, entry, {
                      instanceId:
                        entry.instanceId === TEAM_SCALE_SELF_INSTANCE_ID
                          ? instanceId
                          : entry.instanceId,
                    }),
                  ),
                },
          );
        }

        const sidebar = page.locator("openclaw-app-sidebar");
        const lastPin = sidebar.locator(
          `.sidebar-rail [data-sidebar-entry="session:${fixture.pinnedKeys[29]}"]`,
        );
        await lastPin
          .getByRole("link", { name: "Project dashboard 30", exact: true })
          .waitFor({ state: "attached" });
        expect(
          await sidebar.locator('.sidebar-rail [data-sidebar-entry^="session:"]').count(),
        ).toBe(30);
        await sidebar.locator('[data-sidebar-entry="plugin:team-scale-6/overview"]').waitFor();
        await sidebar.locator('[data-navigation-view="online"]').click();
        const onlineToggle = sidebar.locator(".sidebar-online .sidebar-session-group-toggle");
        if ((await onlineToggle.getAttribute("aria-expanded")) === "false") {
          await onlineToggle.click();
        }
        await sidebar.locator('[data-online-user-id="team-person-120"]').waitFor();
        expect(await sidebar.locator("[data-online-user-id]").count()).toBe(120);

        await page
          .frameLocator(".board-widget__frame")
          .frameLocator("iframe")
          .getByText("Team metric 1", { exact: true })
          .waitFor();
        await page
          .frameLocator(".chat-tool-card__preview-frame")
          .last()
          .frameLocator("iframe")
          .getByText("Team metric 12", { exact: true })
          .waitFor();

        const rosterRequests = await gateway.getRequests("sessions.list");
        expect(rosterRequests.some((request) => asRecord(request.params)?.limit === 200)).toBe(
          true,
        );
      },
    );
  });
});
