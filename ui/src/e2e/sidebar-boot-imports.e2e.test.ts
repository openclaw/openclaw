import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
  startControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import { createTeamScaleSidebarListOwner } from "../test-helpers/control-ui-sidebar-list-fixture.ts";
import { createControlUiTeamScaleFixture } from "../test-helpers/control-ui-team-scale-fixture.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Sidebar optional boot imports",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
});

suite.define(() => {
  it("restores the sidebar on another chat route while a peer resolves its profile", async () => {
    const fixture = createControlUiTeamScaleFixture({ baseUrl: suite.server.baseUrl });
    const archived = fixture.scenario.sessions![1]!;
    archived.archived = true;
    const lists = createTeamScaleSidebarListOwner(fixture.sidebarListInput);
    await suite.withPage({ serviceWorkers: "block" }, async ({ page, context }) => {
      await context.addInitScript(
        ({ key, entries }) => {
          if (!localStorage.getItem(key)) {
            localStorage.setItem(
              key,
              JSON.stringify({
                sidebarAgentsMode: "chip",
                railShortcuts: entries,
                navigationByProfile: { "team-person-001": { railShortcuts: entries } },
              }),
            );
          }
        },
        {
          key: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
          entries: fixture.sidebarEntries,
        },
      );
      const install = (target: typeof page, unresolved = false) =>
        installMockGateway(
          target,
          unresolved
            ? {
                ...fixture.scenario,
                presenceUsers: fixture.scenario.presenceUsers!.filter((user) => !user.self),
                heldMethods: ["users.self"],
              }
            : { ...fixture.scenario, heldMethods: ["connect"] },
          {
            requestHandlers: {
              "sessions.list": (value) => {
                const params = asRecord(value);
                if (!params) {
                  throw new Error("sessions.list requires query parameters");
                }
                return lists.list(params).result;
              },
              "cron.list": (value) => fixture.listCronJobs(asRecord(value) ?? {}),
            },
          },
        );
      const gateway = await install(page);
      await page.goto(
        controlUiSessionUrl(suite.server.baseUrl, fixture.selectedSessionKey, "chat"),
      );
      await gateway.waitForRequest("connect");
      await gateway.resolveDeferred("connect");
      await page.locator('aside.sidebar[data-snapshot-saved="true"]').waitFor();
      const peer = await context.newPage();
      const peerGateway = await install(peer, true);
      await peer.goto(controlUiSessionUrl(suite.server.baseUrl, archived.key, "chat"));
      await peerGateway.waitForRequest("users.self");
      await evaluateControlUiContext(peer, async (app) => {
        await app.agents.ensureList();
        await app.sessions.groupsLoad();
        if (app.gateway.snapshot.selfUser !== undefined) {
          throw new Error("The peer's profile must still be unresolved");
        }
      });
      // Flush the peer's native pending publication before reloading another route.
      await peer.evaluate(() => window.dispatchEvent(new Event("pagehide")));
      for (const face of ["chat", "dashboard"] as const) {
        await page.goto(
          controlUiSessionUrl(suite.server.baseUrl, fixture.selectedSessionKey, face),
        );
        await gateway.waitForRequest("connect");
        await page.locator('aside.sidebar[data-snapshot-state="cached"]').waitFor();
        await page.locator(".sidebar-recent-session").nth(10).waitFor();
      }
    });
  });

  it("loads the Inbox renderer on interaction while keeping its badge available at boot", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const panelRequests: string[] = [];
      page.on("request", (request) => {
        if (new URL(request.url()).pathname.endsWith("/sidebar-attention-panel.runtime.tsx")) {
          panelRequests.push(request.url());
        }
      });
      await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.locator(".agent-chat__composer-combobox textarea").waitFor();
      const inbox = page.locator(".sidebar-issues-button");
      await inbox.waitFor();
      expect(panelRequests).toHaveLength(0);
      await inbox.click();
      await page.locator(".sidebar-issues-panel").waitFor();
      expect(panelRequests).toHaveLength(1);
      expect(await inbox.getAttribute("aria-expanded")).toBe("true");
    });
  });
});
