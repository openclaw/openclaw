import { expect, it } from "vitest";
import { SIDEBAR_SESSION_ROSTER_LIMIT } from "../../../src/shared/session-list-limits.ts";
import { getControlUiContextHandle } from "../test-helpers/control-ui-e2e-context.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { selectAllSidebarSessions } from "./sidebar-navigation.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI warm owner-first refresh" });
const rosterMatch = { includeGlobal: true };

function sessionRow(ownerId: string, key: string, label: string, updatedAt: number) {
  const owner = {
    type: "human" as const,
    id: ownerId,
    label: ownerId === "profile-ada" ? "Ada" : "Bob",
  };
  return {
    key,
    kind: "direct" as const,
    label,
    createdActor: owner,
    owner: { actor: owner },
    updatedAt,
  };
}

suite.define(() => {
  it("keeps foreign-owned rows visible while one warm owner-first refresh is in flight", () =>
    suite.withPage({ viewport: { height: 800, width: 1200 } }, async ({ page }) => {
      const adaRow = sessionRow("profile-ada", "agent:main:ada", "Ada research", 2);
      const bobRow = sessionRow("profile-bob", "agent:main:bob", "Bob operations", 1);
      const sharedRoster = {
        count: 2,
        owners: [adaRow.owner.actor, bobRow.owner.actor],
        defaults: { contextTokens: null, model: null, modelProvider: null },
        path: "",
        sessions: [adaRow, bobRow],
        ts: 1,
      };
      const gateway = await installMockGateway(page, {
        presenceUsers: [{ self: true, id: "profile-ada", name: "Ada" }],
        sessionKey: "agent:main:ada",
        methodResponses: {
          "sessions.subscribe": { subscribed: true, list: sharedRoster },
          "sessions.list": sharedRoster,
        },
      });

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:ada"));
      const ada = page.locator('[data-session-key="agent:main:ada"]');
      const bob = page.locator('[data-session-key="agent:main:bob"]');
      await ada.waitFor();
      expect(await bob.count()).toBe(0);
      await selectAllSidebarSessions(page);
      await bob.waitFor();

      // Hold the single warm roster projection open and observe the existing DOM.
      const before = (await gateway.getRequests("sessions.list", rosterMatch)).length;
      await gateway.deferNext("sessions.list", rosterMatch);
      await gateway.emitGatewayEvent("sessions.changed", {
        sessionKey: adaRow.key,
        key: adaRow.key,
        kind: "direct",
        reason: "create",
        updatedAt: 3,
      });
      await gateway.waitForRequest("sessions.list", { after: before, match: rosterMatch });
      const applicationHandle = await getControlUiContextHandle(page);
      const refreshProbe = await applicationHandle.evaluateHandle((application) => {
        const sidebar = document.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>(
          "openclaw-app-sidebar",
        );
        const sessions = application.sessions;
        const row = sidebar?.querySelector('[data-session-key="agent:main:bob"]');
        const scope = sessions?.captureConnectionScope();
        if (!sidebar || !sessions || !row || !scope) {
          throw new Error("The warm session owner or sidebar is unavailable");
        }
        let removed = false;
        const observer = new MutationObserver((records) => {
          removed ||= records.some(({ removedNodes }) =>
            Array.from(removedNodes).some((node) => node === row || node.contains(row)),
          );
        });
        observer.observe(sidebar, { childList: true, subtree: true });
        const revision = sessions.canonicalListRevision;
        return {
          observer,
          revision,
          sessions,
          sidebar,
          snapshot: (completed = false) => ({
            connected: sessions.isConnectionScopeCurrent(scope),
            loading: sessions.state.loading,
            revisionAdvanced: completed
              ? sessions.canonicalListRevision > revision
              : sessions.canonicalListRevision !== revision,
            rowConnected: row.isConnected,
            rowRemoved: removed,
          }),
        };
      });
      const inFlight = await refreshProbe.evaluate(async (probe) => {
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });
        await probe.sidebar.updateComplete;
        return probe.snapshot();
      });
      const stableRows = { connected: true, rowConnected: true, rowRemoved: false };
      expect(inFlight).toEqual({ ...stableRows, loading: true, revisionAdvanced: false });
      expect(
        (await gateway.getRequests("sessions.list", rosterMatch))
          .slice(before)
          .map((request) => request.params),
      ).toEqual([
        expect.objectContaining({ ownerFirst: true, limit: SIDEBAR_SESSION_ROSTER_LIMIT }),
      ]);

      expect(await bob.count()).toBe(1);
      expect(await ada.count()).toBe(1);

      await gateway.resolveDeferred("sessions.list", sharedRoster);
      const completed = await refreshProbe.evaluate(async (probe) => {
        if (probe.sessions.canonicalListRevision === probe.revision) {
          await new Promise<void>((resolve) => {
            const unsubscribe = probe.sessions.subscribe(() => {
              if (probe.sessions.canonicalListRevision > probe.revision) {
                unsubscribe();
                resolve();
              }
            });
            if (probe.sessions.canonicalListRevision > probe.revision) {
              unsubscribe();
              resolve();
            }
          });
        }
        await probe.sidebar.updateComplete;
        probe.observer.disconnect();
        return probe.snapshot(true);
      });
      expect(completed).toEqual({ ...stableRows, loading: false, revisionAdvanced: true });
      await expect.poll(() => bob.count()).toBe(1);
      expect(await ada.count()).toBe(1);
      await refreshProbe.dispose();
      await applicationHandle.dispose();
    }));
});
