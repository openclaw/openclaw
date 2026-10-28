import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { pauseVirtualClock } from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  captureUiProofEnabled,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";
import { sessionsList } from "./session-ownership-fixtures.test-support.ts";
import { selectAllSidebarSessions } from "./sidebar-navigation.test-support.ts";
import {
  chooseSidebarMenuOption,
  chooseSidebarOwner,
  closeSidebarMenu,
} from "./sidebar-session-menu.test-support.ts";

const suite = createSessionManagementE2eSuite();
const rosterMatch = { includeGlobal: true };

suite.define(() => {
  it.each(["fine", "coarse"] as const)(
    "keeps inline-owner titles clear of surfaced actions with a %s pointer",
    async (pointer) => {
      const context = await suite.newBrowserContext({
        ...createControlUiE2eContextOptions(),
        hasTouch: pointer === "coarse",
      });
      const page = await context.newPage();
      const response = sessionsList(undefined, false, { categories: false });
      response.sessions[0]!.label =
        "A long owner-scoped session title that must stop before the archive action";
      const gateway = await installMockGateway(page, {
        sessionKey: "agent:main:ada",
        presenceUsers: [{ self: true, id: "profile-patrick", name: "Patrick" }],
        methodResponses: {
          "sessions.list": {
            cases: [
              {
                match: { ownerId: "profile-ada" },
                response: { ...response, count: 1, sessions: [response.sessions[0]] },
              },
              { response },
            ],
          },
        },
      });
      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:ada"));
        await selectAllSidebarSessions(page);
        await chooseSidebarMenuOption(page, "Group by", "Person");
        await closeSidebarMenu(page);
        await chooseSidebarOwner(page, "owner:profile-ada");
        await gateway.waitForRequest("sessions.list", { match: { ownerId: "profile-ada" } });
        const row = page.locator(
          '.sidebar-recent-sessions__group--inline-owner .sidebar-recent-session[data-session-key="agent:main:ada"]',
        );
        const title = row.locator(".sidebar-recent-session__name");
        await row.waitFor({ state: "visible" });
        await page.mouse.move(900, 400);
        const coarse = pointer === "coarse";
        expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(coarse);
        expect(await page.locator(".shell--mobile-nav").count()).toBe(0);
        const restingWidth = await title.evaluate((element) => element.clientWidth);
        const states = coarse
          ? (["rest", "hover", "focus"] as const)
          : (["hover", "focus"] as const);
        for (const state of states) {
          if (state === "hover") {
            await row.hover();
          } else if (state === "focus") {
            await row.locator("[data-sidebar-session-archive]").focus();
            await page.mouse.move(900, 400);
          }
          const titleBox = await title.boundingBox();
          const actionsBox = await row.locator(".session-row-actions").boundingBox();
          if (!titleBox || !actionsBox) {
            throw new Error("Expected visible owner title and actions");
          }
          if (captureUiProofEnabled && state === (coarse ? "rest" : "hover")) {
            const frame = await takeControlUiScreenshotFrame(page, row, [title], {
              elements: [row],
              animations: "disabled",
            });
            writeFileSync(
              path.join(suite.artifactDir, "inline-owner-row.png"),
              frame.elements[0]!.png,
            );
            writeFileSync(
              path.join(suite.artifactDir, "inline-owner-layout.json"),
              JSON.stringify({ titleBox, actionsBox, restingWidth }, null, 2),
            );
          }
          if (!coarse) {
            expect(titleBox.width).toBeLessThan(restingWidth);
          } else {
            expect(
              await row
                .locator("[data-sidebar-session-archive]")
                .evaluate((element) => getComputedStyle(element).opacity),
            ).toBe("1");
          }
          expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(actionsBox.x);
        }
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );

  it("keeps the child-toggle point safe after remote child deletion", async () => {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const main = sessionRow("agent:main:main", "Main", 1);
    const childKey = "agent:main:pointer-child";
    const parent = sessionRow("agent:main:pointer-parent", "Pointer parent", 4, {
      childSessions: [childKey],
    });
    const child = sessionRow(childKey, "Disposable child", 3, {
      spawnedBy: parent.key,
      parentSessionKey: parent.key,
    });
    const control = sessionRow("agent:main:archive-control", "Archive control", 2);
    const gateway = await installMockGateway(page, {
      sessions: [main, parent, child, control],
      sessionArchiveFiltering: true,
      sessionKey: main.key,
    });
    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, main.key));
      const rowFor = (key: string) =>
        page.locator(`.sidebar-recent-session[data-session-key="${key}"]`).first();
      // Exercise the real lazy action owner before relying on a negative RPC assertion.
      const controlRow = rowFor(control.key);
      await controlRow.hover();
      await controlRow.locator("[data-sidebar-session-archive]").click();
      await gateway.waitForRequest("sessions.patch", {
        match: { key: control.key, archived: true },
      });
      await controlRow.waitFor({ state: "detached" });
      const archivedControl = await gateway.getSessionRow(control.key);
      expect(archivedControl.archived).toBe(true);

      const row = rowFor(parent.key);
      const toggle = row.locator(`[data-child-session-toggle="${parent.key}"]`);
      await row.hover();
      if ((await toggle.getAttribute("aria-expanded")) === "true") {
        await toggle.click();
        await expect.poll(() => toggle.getAttribute("aria-expanded")).toBe("false");
      }
      const bounds = await toggle.boundingBox();
      if (!bounds) {
        throw new Error("Expected a visible child-session toggle");
      }
      const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      await page.mouse.move(point.x, point.y);
      await page.mouse.click(point.x, point.y);
      await expect.poll(() => toggle.getAttribute("aria-expanded")).toBe("true");
      await rowFor(child.key).waitFor({ state: "visible" });

      await page.clock.install();
      await pauseVirtualClock(page);
      const beforeList = (await gateway.getRequests("sessions.list", rosterMatch)).length;
      const rows = [main, { ...parent, childSessions: [], updatedAt: 5 }, archivedControl];
      await gateway.setSessionsListResponse(sessionsListResponse(rows));
      // Replay the deletion owner's exact removal and broad roster notification.
      await gateway.emitGatewayEvent("sessions.changed", {
        sessionKey: child.key,
        sessionId: child.sessionId,
        agentId: "main",
        reason: "delete",
      });
      await gateway.emitGatewayEvent("sessions.changed", { reason: "delete" });
      await page.clock.runFor(5_001);
      await gateway.waitForRequest("sessions.list", { after: beforeList, match: rosterMatch });
      await toggle.waitFor({ state: "detached" });
      await page.clock.resume();
      const pointHitsArchive = await row.evaluate((element, { x, y }) => {
        const root = element.getRootNode();
        const target = (root instanceof ShadowRoot ? root : document).elementFromPoint(x, y);
        return Boolean(target?.closest("[data-sidebar-session-archive]"));
      }, point);
      if (captureUiProofEnabled) {
        const frame = await takeControlUiScreenshotFrame(
          page,
          row,
          [row.getByText("Pointer parent", { exact: true })],
          {
            elements: [row],
            animations: "disabled",
          },
        );
        writeFileSync(path.join(suite.artifactDir, "child-toggle-after-delete.png"), frame.png);
        writeFileSync(path.join(suite.artifactDir, "child-toggle-row.png"), frame.elements[0]!.png);
      }

      const click = await page.evaluateHandle(() => {
        const captured: { trusted?: boolean; archive?: boolean } = {};
        document.addEventListener(
          "click",
          (event) => {
            captured.trusted = event.isTrusted;
            captured.archive = event
              .composedPath()
              .some(
                (target) =>
                  target instanceof Element && target.hasAttribute("data-sidebar-session-archive"),
              );
          },
          { capture: true, once: true },
        );
        return captured;
      });
      await page.mouse.click(point.x, point.y);
      const clickedTarget = await click.jsonValue();
      await click.dispose();
      const archiveRequests = await gateway.getRequests("sessions.patch", {
        key: parent.key,
        archived: true,
      });
      if (captureUiProofEnabled) {
        writeFileSync(
          path.join(suite.artifactDir, "child-toggle-pointer.json"),
          JSON.stringify(
            { point, pointHitsArchive, clickedTarget, archiveRequestCount: archiveRequests.length },
            null,
            2,
          ),
        );
      }
      expect(pointHitsArchive).toBe(false);
      expect(clickedTarget).toEqual({ trusted: true, archive: false });
      expect(archiveRequests).toEqual([]);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
