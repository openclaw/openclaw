import { expect, it } from "vitest";
import { SIDEBAR_SESSION_ROSTER_LIMIT } from "../../../src/shared/session-list-limits.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { ownerRoster } from "./session-ownership-fixtures.test-support.ts";
import { selectAllSidebarSessions } from "./sidebar-navigation.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI owner-first session roster" });
const rosterMatch = { includeGlobal: true, ownerFirst: true };
const mineMatch = { includeGlobal: true, ownerId: "profile-ada" };
const rosterParams = { ownerFirst: true, limit: SIDEBAR_SESSION_ROSTER_LIMIT };

function sessionsList() {
  const sessions = ["ada", "bob"].map((name, index) => {
    const owner = { type: "human" as const, id: `profile-${name}`, label: index ? "Bob" : "Ada" };
    return {
      key: `agent:main:${name}`,
      kind: "direct" as const,
      label: index ? "Bob operations" : "Ada research",
      createdActor: owner,
      owner: { actor: owner },
      updatedAt: 2 - index,
    };
  });
  return ownerRoster(
    sessions,
    sessions.map((session) => session.owner.actor),
  );
}

suite.define(() => {
  it("hydrates the owner-first roster separately from the event subscription", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 800, width: 1200 } });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      heldMethods: ["sessions.list"],
      presenceUsers: [{ self: true, id: "profile-ada", name: "Ada" }],
      sessionKey: "agent:main:ada",
      methodResponses: { "sessions.list": sessionsList() },
    });

    try {
      // A literal key avoids the independent slug lookup while the roster is deferred.
      await page.goto(`${suite.server?.baseUrl ?? ""}chat/main/~key/ada`);
      expect((await gateway.waitForRequest("sessions.subscribe")).params).toEqual({});
      const roster = await gateway.waitForRequest("sessions.list", { match: rosterMatch });
      expect(roster.params).toMatchObject(rosterParams);
      const adaRow = page.locator('[data-session-key="agent:main:ada"]');
      const bobRow = page.locator('[data-session-key="agent:main:bob"]');
      // The selected session can resolve independently while the roster is deferred.
      await expect.poll(() => adaRow.count()).toBe(1);
      await expect.poll(() => bobRow.count()).toBe(0);
      expect(await gateway.getRequests("sessions.list", rosterMatch)).toHaveLength(1);

      await gateway.resolveDeferred("sessions.list");
      const mineRoster = await gateway.waitForRequest("sessions.list", { match: mineMatch });
      expect(mineRoster.params).not.toHaveProperty("ownerFirst");
      expect(mineRoster.params).toMatchObject({ limit: SIDEBAR_SESSION_ROSTER_LIMIT });
      await adaRow.waitFor();
      // My sessions hydrates only the current human until All owners is selected.
      expect(await bobRow.count()).toBe(0);
      // The canonical owner-first window and self filter are distinct query owners.
      expect(await gateway.getRequests("sessions.list", rosterMatch)).toHaveLength(1);
      expect(await gateway.getRequests("sessions.list", mineMatch)).toHaveLength(1);
      expect(await gateway.getRequests("sessions.list", { includeGlobal: true })).toHaveLength(2);
      await selectAllSidebarSessions(page);
      const allRoster = await gateway.waitForRequest("sessions.list", {
        after: 1,
        match: rosterMatch,
      });
      expect(allRoster.params).toMatchObject(rosterParams);
      expect(allRoster.params).not.toHaveProperty("ownerId");
      await bobRow.waitFor();
      expect(await gateway.getRequests("sessions.list", rosterMatch)).toHaveLength(2);
      expect(await gateway.getRequests("sessions.list", mineMatch)).toHaveLength(1);
      expect(await gateway.getRequests("sessions.list", { includeGlobal: true })).toHaveLength(3);
    } finally {
      await context.close();
    }
  });
});
