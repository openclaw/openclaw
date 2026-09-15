import { expect, it } from "vitest";
import { reconnectMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { expectRequestCountStable } from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  activateSelfRemovingControl,
  captureUiProof,
  controlUiSessionPath,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
  waitForPatch,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it.each([
    { surface: "header", reconnect: false },
    { surface: "header", reconnect: true },
    { surface: "sidebar", reconnect: false },
  ])(
    "$surface archive Undo survives navigation and fences reconnect=$reconnect",
    async ({ surface, reconnect }) => {
      const context = await suite.browser.newContext(createControlUiE2eContextOptions());
      const page = await context.newPage();
      const main = sessionRow("agent:main:main", "Main", 1);
      const target = sessionRow("agent:main:undo-target", "Undo target", 2);
      const archived = sessionRow("agent:main:undo-archive", "Undo archive", 3, { pinned: true });
      const gateway = await installMockGateway(page, {
        methodResponses: { "sessions.list": sessionsListResponse([main, target, archived]) },
        sessionArchiveFiltering: true,
        sessionKey: archived.key,
      });
      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, archived.key));
        const rowFor = (key: string) =>
          page.locator(`.sidebar-recent-session[data-session-key="${key}"]`);
        await rowFor(archived.key).waitFor({ state: "visible" });
        if (surface === "header") {
          await page.locator(".chat-header-session-menu__trigger").click();
        } else {
          await rowFor(archived.key).hover();
          await rowFor(archived.key).getByRole("button", { name: "Open session menu" }).click();
        }
        await activateSelfRemovingControl(
          page
            .locator(
              surface === "header" ? "openclaw-chat-header-session-menu" : "openclaw-session-menu",
            )
            .getByRole("menuitem", { name: "Archive session", exact: true }),
        );
        await waitForPatch(
          gateway,
          (params) => params.key === archived.key && params.archived === true,
        );
        const undo = page.getByRole("button", { name: "Undo", exact: true });
        await undo.waitFor({ state: "visible" });
        await rowFor(target.key).click();
        await expect
          .poll(() => new URL(page.url()).pathname)
          .toBe(controlUiSessionPath(target.key));
        if (reconnect) {
          await undo.hover();
          await reconnectMockGateway(page, gateway);
        }
        await undo.click();
        if (reconnect) {
          await expectRequestCountStable(gateway, "sessions.patch", 1);
          expect(await rowFor(archived.key).count()).toBe(0);
          return;
        }
        const restored = await waitForPatch(
          gateway,
          (params) => params.key === archived.key && params.archived === false,
        );
        expect(restored.params).toMatchObject({
          expectedSessionId: archived.sessionId,
          pinned: true,
        });
        await rowFor(archived.key).waitFor({ state: "visible" });
        expect(new URL(page.url()).pathname).toBe(controlUiSessionPath(target.key));
      } finally {
        await context.close();
      }
    },
  );

  it.each([false, true])(
    "keeps another agent's pagination usable after Undo (selection queued=%s)",
    async (queued) => {
      const context = await suite.browser.newContext(createControlUiE2eContextOptions());
      const page = await context.newPage();
      const archived = sessionRow("agent:main:undo-cross-agent", "Restored original", 3, {
        pinned: true,
      });
      const mainRows = [sessionRow("agent:main:main", "Main", 1), archived];
      const researchRows = [
        sessionRow("agent:research:main", "Research", 4),
        sessionRow("agent:research:first", "Research first", 3),
        sessionRow("agent:research:second", "Research second", 2),
      ] as const;
      const agentsList = {
        agents: [
          { id: "main", name: "Main" },
          { id: "research", name: "Research" },
        ],
        defaultId: "main",
        mainKey: "main",
        scope: "agent",
      };
      const gateway = await installMockGateway(page, {
        sessions: [...mainRows, ...researchRows],
        methodResponses: {
          "agents.list": agentsList,
          "sessions.list": {
            cases: [
              {
                match: { agentId: "research", offset: 2 },
                response: sessionsListResponse(researchRows.slice(2), { offset: 2, totalCount: 3 }),
              },
              {
                match: { agentId: "research" },
                response: sessionsListResponse(researchRows.slice(0, 2), {
                  hasMore: true,
                  nextOffset: 2,
                  totalCount: 3,
                }),
              },
              { response: sessionsListResponse(mainRows) },
            ],
          },
        },
        sessionArchiveFiltering: true,
        sessionKey: archived.key,
      });
      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, archived.key));
        const sidebar = page.locator("openclaw-app-sidebar");
        const rowFor = (key: string) =>
          sidebar.locator(`.sidebar-recent-session[data-session-key="${key}"]`);
        const switchAgent = async (name: string) => {
          await sidebar.getByRole("button", { name: /Switch agent/ }).click();
          await sidebar
            .locator("wa-dropdown.sidebar-agent-menu")
            .getByRole("menuitemradio", { name, exact: true })
            .click();
        };
        await rowFor(archived.key).waitFor({ state: "visible" });
        await captureUiProof(suite, page, "cross-agent-initial.png");
        await page.locator(".chat-header-session-menu__trigger").click();
        await activateSelfRemovingControl(
          page
            .locator("openclaw-chat-header-session-menu")
            .getByRole("menuitem", { name: "Archive session", exact: true }),
        );
        const undo = page.getByRole("button", { name: "Undo", exact: true });
        await undo.waitFor({ state: "visible" });
        if (queued) {
          const listMatch = { agentId: "main", includeGlobal: true };
          const listsBefore = (await gateway.getRequests("sessions.list", listMatch)).length;
          await gateway.deferNext("sessions.list", listMatch);
          await gateway.emitGatewayEvent("sessions.changed", { agentId: "main", reason: "update" });
          await gateway.waitForRequest("sessions.list", {
            after: listsBefore,
            match: listMatch,
          });
        }
        await switchAgent("Research");
        if (!queued) {
          await rowFor(researchRows[1].key).waitFor({ state: "visible" });
        }
        await undo.click();
        await waitForPatch(
          gateway,
          (params) => params.key === archived.key && params.archived === false,
        );
        await expectRequestCountStable(gateway, "sessions.patch", 2);
        if (queued) {
          await gateway.resolveDeferred("sessions.list", sessionsListResponse(mainRows));
        }
        await captureUiProof(suite, page, "cross-agent-after-undo.png");
        await rowFor(researchRows[1].key).waitFor({ state: "visible" });
        await sidebar.getByRole("button", { name: "Load more sessions", exact: true }).click();
        await gateway.waitForRequest("sessions.list", {
          match: { agentId: "research", offset: 2 },
        });
        await rowFor(researchRows[2].key).waitFor({ state: "visible" });
        await captureUiProof(suite, page, "cross-agent-after-pagination.png");
        await switchAgent("Main");
        await rowFor(archived.key).waitFor({ state: "visible" });
        await rowFor(archived.key)
          .getByRole("button", { name: "Unpin session", exact: true })
          .waitFor({ state: "attached" });
      } finally {
        await context.close();
      }
    },
  );
});
