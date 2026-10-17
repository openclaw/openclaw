import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { persistColdLoadWarmState } from "../../../scripts/lib/control-ui-bench-warm-state.ts";
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
                sidebarAgentsMode: "chip",
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
        await sidebar.locator('[data-sidebar-entry="plugin:team-scale-7/overview"]').waitFor();
        await sidebar.locator('[data-navigation-view="online"]').click();
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
        await page
          .locator("openclaw-message-reaction-picker")
          .first()
          .waitFor({ state: "attached" });
        await page.locator(".chat-tool-card__widget-actions").first().waitFor();
        await page.locator(".context-usage").waitFor();

        const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");
        await thread.hover();
        const coverage = thread.evaluate(async (element) => {
          const initialTop = element.scrollTop;
          const padding = getComputedStyle(element);
          const topPadding = Number.parseFloat(padding.paddingTop);
          const bottomPadding = Number.parseFloat(padding.paddingBottom);
          const frames: Array<{ scrollTop: number; covered: boolean }> = [];
          for (let frame = 0; frame < 20; frame++) {
            await new Promise<void>((resolve) => {
              requestAnimationFrame(() => resolve());
            });
            const viewport = element.getBoundingClientRect();
            const rows = [...element.querySelectorAll(".chat-virtual-row")].map((row) =>
              row.getBoundingClientRect(),
            );
            frames.push({
              scrollTop: element.scrollTop,
              covered:
                Math.min(...rows.map((row) => row.top)) <= viewport.top + topPadding + 1 &&
                Math.max(...rows.map((row) => row.bottom)) >= viewport.bottom - bottomPadding - 1,
            });
          }
          return { initialTop, frames };
        });
        await page.mouse.wheel(0, -1800);
        const sampled = await coverage;
        expect(sampled.frames.some((frame) => frame.scrollTop < sampled.initialTop)).toBe(true);
        expect(
          sampled.frames.every((frame) => frame.covered),
          JSON.stringify(sampled),
        ).toBe(true);

        await page.locator('aside.sidebar[data-snapshot-saved="true"]').waitFor();
        await page.evaluate("globalThis.__name = (fn) => fn");
        const warm = await page.evaluate(persistColdLoadWarmState, {
          sessionKey: fixture.selectedSessionKey,
          sidebarView: "online",
        });
        expect(warm).toMatchObject({
          databaseVersion: 8,
          projectionVersion: 3,
          sidebarView: "online",
          sidebarPeople: 120,
        });
        expect(warm.messages).toBeLessThanOrEqual(80);
        expect(warm.messages).toBeGreaterThan(0);
        await page.reload();
        await sidebar.locator('[data-navigation-view="online"][aria-pressed="true"]').waitFor();
        await sidebar.locator('[data-online-user-id="team-person-120"]').waitFor();
        await page
          .locator(".chat-pane__session-title-text", { hasText: "Project dashboard 1" })
          .waitFor();

        const rosterRequests = await gateway.getRequests("sessions.list");
        expect(rosterRequests.some((request) => asRecord(request.params)?.limit === 200)).toBe(
          true,
        );
      },
    );
  });
});
