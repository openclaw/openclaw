import { it, expect } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { pauseVirtualClock, reconnectMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { expectRequestCountStable } from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import * as ui from "./session-management.compact.test-support.ts";
import {
  controlUiSessionPath,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";
import { captureFrame } from "./sidebar-assertions.test-support.ts";
import { openSidebarPages } from "./sidebar-customization.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it("holds an individual archive across leaving the Sessions page until its Undo window closes", () =>
    suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const main = sessionRow("agent:main:main", "Main", 1);
      const target = sessionRow("agent:main:pending-archive", "Pending archive", 2, {
        pinned: true,
      });
      const gateway = await installMockGateway(page, {
        sessions: [main, target],
        sessionKey: main.key,
        sessionArchiveFiltering: true,
      });

      await page.goto(`${suite.server.baseUrl}sessions`);
      const row = page.locator(".session-data-row").filter({ hasText: target.label });
      await ui.visible(row);
      await ui.archiveSession(page, row, "list");
      const undo = ui.button(page, "Undo");
      await ui.visible(undo);
      await row.waitFor({ state: "detached" });
      const pages = await openSidebarPages(page);
      await pages.getByRole("link", { name: "Usage", exact: true }).click();
      await page.waitForURL((url) => url.pathname.endsWith("/usage"));
      await page.locator("openclaw-sessions-page").waitFor({ state: "detached" });
      const destination = new URL(page.url()).pathname;
      // The window outlives the page; nothing is written until it closes.
      await ui.visible(undo);
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);

      await ui.closeArchiveUndoToast(page);
      const archived = await ui.sessionPatch(gateway, target.key, { archived: true });
      expect(archived.params).toMatchObject({
        key: target.key,
        expectedSessionId: target.sessionId,
        archived: true,
      });
      await expectRequestCountStable(gateway, "sessions.patch", 1);
      expect(new URL(page.url()).pathname).toBe(destination);
    }));

  it.each([
    { surface: "header", reconnect: false },
    { surface: "header", reconnect: true },
    { surface: "sidebar", reconnect: false },
  ] as const)(
    "$surface held archive survives navigation, Undo restores it without a write, reconnect=$reconnect",
    ({ surface, reconnect }) =>
      suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const main = sessionRow("agent:main:main", "Main", 1);
        const target = sessionRow("agent:main:undo-target", "Undo target", 2);
        const archived = sessionRow("agent:main:undo-archive", "Undo archive", 3, { pinned: true });
        const gateway = await ui.installSessionRows(page, [main, target, archived], {
          sessionArchiveFiltering: true,
          sessionKey: archived.key,
        });

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, archived.key));
        const rowFor = ui.sessionRows(page);
        await ui.visible(rowFor(archived.key));
        await ui.archiveSession(page, rowFor(archived.key), surface);
        const undo = ui.button(page, "Undo");
        await ui.visible(undo);
        await ui.expectCount(rowFor(archived.key), 0);
        await rowFor(target.key).click();
        await expect
          .poll(() => new URL(page.url()).pathname)
          .toBe(controlUiSessionPath(target.key));
        if (reconnect) {
          // Accepted edge: a reconnect retires the held archive, so the row returns.
          await undo.hover();
          await reconnectMockGateway(page, gateway);
          await ui.visible(rowFor(archived.key));
        }
        await undo.click();
        await ui.visible(rowFor(archived.key));
        await expectRequestCountStable(gateway, "sessions.patch", 0);
        expect(new URL(page.url()).pathname).toBe(controlUiSessionPath(target.key));
      }),
  );

  it.each([false, true])(
    "keeps another agent's pagination usable after Undo (selection queued=%s)",
    (queued) =>
      suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        await page.clock.install();
        const archived = sessionRow("agent:main:undo-cross-agent", "Restored original", 3, {
          pinned: true,
        });
        const mainRows = [sessionRow("agent:main:main", "Main", 1), archived];
        const researchRows = [
          sessionRow("agent:research:main", "Research", 4),
          sessionRow("agent:research:first", "Research first", 3),
          sessionRow("agent:research:second", "Research second", 2),
        ] as const;
        const gateway = await installMockGateway(page, {
          sessions: [...mainRows, ...researchRows],
          methodResponses: {
            "agents.list": ui.mainAndResearchAgents,
            "sessions.list": {
              cases: [
                ...[2, 0].map((offset) => ({
                  match: { agentId: "research", ...(offset ? { offset } : {}) },
                  response: { ...ui.sessionPage(researchRows, offset, 2), limitApplied: 50 },
                })),
                { response: sessionsListResponse(mainRows) },
              ],
            },
          },
          sessionArchiveFiltering: true,
          sessionKey: archived.key,
        });

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, archived.key));
        const sidebar = page.locator("openclaw-app-sidebar");
        const rowFor = ui.sessionRows(sidebar);
        await ui.visible(rowFor(archived.key));

        await ui.archiveSession(page, rowFor(archived.key), "header");
        const undo = ui.button(page, "Undo");
        await ui.visible(undo);
        if (queued) {
          await undo.hover();
          const mainRoster = { agentId: "main", includeGlobal: true };
          const listsBefore = await ui.requestCount(gateway, "sessions.list", mainRoster);
          await gateway.deferNext("sessions.list", mainRoster);
          await pauseVirtualClock(page);
          await gateway.emitGatewayEvent("sessions.changed", { agentId: "main", reason: "update" });
          await page.clock.fastForward(5_001);
          await page.clock.resume();
          await gateway.waitForRequest("sessions.list", {
            after: listsBefore,
            match: mainRoster,
          });
        }
        await ui.switchAgent(sidebar, "Research");
        if (!queued) {
          await ui.visible(rowFor(researchRows[1].key));
        }
        await undo.click();
        await expectRequestCountStable(gateway, "sessions.patch", 0);
        if (queued) {
          await gateway.resolveDeferred("sessions.list", sessionsListResponse(mainRows));
        }

        await ui.visible(rowFor(researchRows[1].key));
        await ui.button(sidebar, "Load more sessions").click();
        await gateway.waitForRequest("sessions.list", {
          match: { agentId: "research", offset: 2 },
        });
        await ui.visible(rowFor(researchRows[2].key));

        await ui.switchAgent(sidebar, "Main");
        await ui.visible(rowFor(archived.key));
        // Cancelling the held archive does not author a personal navigation pin.
        await ui.button(rowFor(archived.key), "Pin session").waitFor({ state: "attached" });
        expect(
          await page
            .locator(`[data-session-section="pinned"] [data-session-key="${archived.key}"]`)
            .count(),
        ).toBe(0);
      }),
  );

  it.each([
    { surface: "header", restore: "unarchive" },
    { surface: "header", restore: "undo" },
    { surface: "list", restore: "undo" },
  ] as const)(
    "keeps the personal pin only when Undo cancels the held archive ($surface, $restore)",
    async ({ surface, restore }) => {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        await page.clock.install();
        const key = "agent:main:archive-personal-pin";
        const target = sessionRow(key, "Release checklist", 20, { pinned: false });
        const other = sessionRow("agent:main:notes", "Research notes", 10);
        const gateway = await installMockGateway(page, {
          sessionKey: key,
          sessions: [target, other],
          sessionArchiveFiltering: true,
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
        const sidebar = page.locator("openclaw-app-sidebar");
        const row = sidebar.locator(`.sidebar-recent-session[data-session-key="${key}"]`);
        await row.waitFor();
        await row.hover();
        await row.getByRole("button", { name: "Pin session", exact: true }).click();
        await row.getByRole("button", { name: "Unpin session", exact: true }).waitFor();
        const readEntries = () =>
          evaluateControlUiContext(page, ({ navigation }) => [
            ...navigation.snapshot.sidebarEntries,
          ]);
        expect(await readEntries()).toContain(`session:${key}`);
        if (surface === "list") {
          await evaluateControlUiContext(page, (context) => context.navigate("sessions"));
          await ui.archiveSession(
            page,
            page.locator(".session-data-row").filter({ hasText: target.label }),
            surface,
          );
        } else {
          await ui.archiveSession(page, row, surface);
        }
        const undo = ui.button(page, "Undo");
        await undo.waitFor();
        // Holding the archive changes nothing yet, including the personal pin.
        expect(await readEntries()).toContain(`session:${key}`);
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
        if (restore === "undo") {
          await undo.click();
        } else {
          await page.mouse.move(600, 200);
          await page.clock.fastForward(6500);
          await undo.waitFor({ state: "detached" });
          await ui.sessionPatch(gateway, key, { archived: true });
          await expect.poll(readEntries).not.toContain(`session:${key}`);
          await evaluateControlUiContext(page, (context) => context.navigate("sessions"));
          await page.getByRole("button", { name: "Filters", exact: true }).click();
          await page
            .locator(".sessions-view-segment label")
            .filter({ has: page.locator('input[value="archived"]') })
            .click();
          await page.keyboard.press("Escape");
          const archivedRow = page.locator(".session-data-row").filter({ hasText: target.label });
          await archivedRow.getByRole("button", { name: "Open session menu" }).click();
          await ui.menuItem(page.locator("openclaw-session-menu"), "Restore session").click();
          await ui.sessionPatch(gateway, key, { archived: false });
        }
        await row.waitFor();
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const dir = createControlUiE2eArtifactDir("archive-personal-pin");
          await captureFrame(dir, `${surface}-${restore}.png`, page.locator(".shell"), [row]);
        }
        await expect
          .poll(async () => (await readEntries()).includes(`session:${key}`))
          .toBe(restore === "undo");
        await row
          .getByRole("button", {
            name: restore === "undo" ? "Unpin session" : "Pin session",
            exact: true,
          })
          .waitFor();
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(
          restore === "undo" ? 0 : 2,
        );
      });
    },
  );
});
