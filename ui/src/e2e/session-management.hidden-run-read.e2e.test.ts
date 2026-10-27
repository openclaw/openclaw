import { expect, it } from "vitest";
import { GATEWAY_SERVER_CAPS } from "../../../packages/gateway-protocol/src/server-capabilities.js";
import {
  waitForControlUiGatewayReady,
  waitForControlUiGatewayReconnecting,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import type { MockGatewayWindow } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import * as support from "./session-management.test-support.ts";

const suite = support.createSessionManagementE2eSuite();
const runPrefix = "agent:main:subagent:hidden-read-";
type ReadTraffic = { active: number; peak: number; completedTargets: number; batches: number[] };
type TrafficWindow = MockGatewayWindow & { hiddenRunReadTraffic?: ReadTraffic };

// Delay actual mock-Gateway responses so an unawaited per-run producer exposes
// its whole burst before any acknowledgement can settle.
function installReadTrafficProbe() {
  const target = window as TrafficWindow;
  const traffic = { active: 0, peak: 0, completedTargets: 0, batches: [] as number[] };
  target.hiddenRunReadTraffic = traffic;
  for (const method of ["sessions.patch", "sessions.patchMany"]) {
    target.openclawControlUiE2eGateway!.setRequestHandler(method, ({ params, respond }) => {
      const request = params as { key?: string; targets?: { key: string }[] };
      const count =
        method === "sessions.patch"
          ? Number(request.key?.startsWith("agent:main:subagent:hidden-read-") ?? false)
          : request.targets!.filter((row) => row.key.startsWith("agent:main:subagent:hidden-read-"))
              .length;
      if (count === 0) {
        respond({});
        return;
      }
      traffic.active += 1;
      traffic.peak = Math.max(traffic.peak, traffic.active);
      if (method === "sessions.patchMany") {
        traffic.batches.push(count);
      }
      window.setTimeout(() => {
        traffic.active -= 1;
        traffic.completedTargets += count;
        respond({});
      }, 200);
    });
  }
}

suite.define(() => {
  it.each(["view parent", "reconnect", "organizer"] as const)(
    "batches 150 hidden-run read acknowledgements through %s",
    (entry) =>
      suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const parentKey = "agent:main:hidden-read-parent";
        const otherKey = "agent:main:hidden-read-other";
        const parent = sessionRow(parentKey, "Parent with hidden runs", 20, { unread: false });
        const other = sessionRow(otherKey, "Other thread", 10, { unread: false });
        const runs = Array.from({ length: 150 }, (_, index) =>
          sessionRow(runPrefix + index, "Hidden run " + index, 30, {
            parentSessionKey: parentKey,
            spawnedBy: parentKey,
            unread: true,
            status: "done",
          }),
        );
        const rows = [parent, other, ...runs];
        const initialRows =
          entry === "reconnect"
            ? [parent, other, ...runs.map((row) => Object.assign({}, row, { unread: false }))]
            : rows;
        const gateway = await support.installMockGateway(
          page,
          {
            sessionKey: otherKey,
            sessions: initialRows,
            featureCapabilities: [GATEWAY_SERVER_CAPS.SESSION_UNREAD_ACK_CONTRACT],
            methodResponses: { "sessions.list": support.sessionsListResponse(initialRows) },
          },
          { afterInitScript: `(${installReadTrafficProbe.toString()})();` },
        );
        await page.goto(support.controlUiSessionUrl(suite.server.baseUrl, otherKey));
        const parentRow = page.locator(`.sidebar-recent-session[data-session-key="${parentKey}"]`);
        await parentRow.waitFor({ state: "visible" });
        if (entry === "organizer") {
          await parentRow.click({ button: "right" });
          await page.getByRole("menuitem", { name: "Mark as read", exact: true }).click();
        } else {
          await parentRow.getByRole("link").click();
          await page.locator('openclaw-chat-pane[aria-hidden="false"]').waitFor();
          if (entry === "reconnect") {
            await gateway.setOnline(false);
            await waitForControlUiGatewayReconnecting(page);
            await gateway.setSessionsListResponse(support.sessionsListResponse(rows));
            await gateway.setOnline(true);
            await waitForControlUiGatewayReady(page);
          }
        }
        await expect
          .poll(() =>
            page.evaluate(() => (window as TrafficWindow).hiddenRunReadTraffic?.completedTargets),
          )
          .toBe(150);
        const traffic = await page.evaluate(() => (window as TrafficWindow).hiddenRunReadTraffic);
        if (!traffic) {
          throw new Error("Hidden-run request probe was not installed");
        }
        const individual = (await gateway.getRequests("sessions.patch")).filter((request) =>
          String(support.requireRecord(request.params).key).startsWith(runPrefix),
        );
        const batch = (await gateway.getRequests("sessions.patchMany")).filter((request) =>
          (support.requireRecord(request.params).targets as { key: string }[]).some((target) =>
            target.key.startsWith(runPrefix),
          ),
        );
        console.info("hidden-run acknowledgement traffic", entry, {
          individual: individual.length,
          batches: traffic.batches,
          peak: traffic.peak,
        });
        expect(individual).toHaveLength(0);
        expect(batch).toHaveLength(2);
        expect(traffic.batches).toEqual([100, 50]);
        expect(traffic.peak).toBe(1);
        await parentRow.click({ button: "right" });
        await page.getByRole("menuitem", { name: "Mark as unread", exact: true }).waitFor();
        await page.keyboard.press("Escape");
        for (const request of batch) {
          const params = support.requireRecord(request.params);
          expect(params.patch).toEqual({ unread: false });
          for (const target of params.targets as Record<string, unknown>[]) {
            expect(target).toMatchObject({
              expectedMarkedUnreadAt: null,
              expectedSessionId: "session:" + String(target.key),
            });
          }
        }
      }),
  );
});
