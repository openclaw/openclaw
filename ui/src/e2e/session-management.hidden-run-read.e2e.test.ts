import { expect, it } from "vitest";
import { GATEWAY_SERVER_CAPS } from "../../../packages/gateway-protocol/src/server-capabilities.js";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
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
type ReadTraffic = {
  active: number;
  peak: number;
  completedTargets: number;
  batches: number[];
  rosterReadsAtFirstAck?: number;
};
type TrafficWindow = MockGatewayWindow & { hiddenRunReadTraffic?: ReadTraffic };

// Delay actual mock-Gateway responses so an unawaited per-run producer exposes
// its whole burst before any acknowledgement can settle.
function installReadTrafficProbe() {
  const target = window as TrafficWindow;
  const traffic: ReadTraffic = { active: 0, peak: 0, completedTargets: 0, batches: [] };
  const mock = target.openclawControlUiE2eGateway!;
  const rosterReads = () =>
    mock
      .findRequests("sessions.list")
      .filter(({ params }) => !(params as { spawnedBy?: string } | undefined)?.spawnedBy).length;
  target.hiddenRunReadTraffic = traffic;
  for (const method of ["sessions.patch", "sessions.patchMany"]) {
    mock.setRequestHandler(method, ({ params, respond, emit }) => {
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
      traffic.rosterReadsAtFirstAck ??= rosterReads();
      traffic.active += 1;
      traffic.peak = Math.max(traffic.peak, traffic.active);
      if (method === "sessions.patchMany") {
        traffic.batches.push(count);
      }
      window.setTimeout(() => {
        traffic.active -= 1;
        traffic.completedTargets += count;
        respond({});
        const keys =
          method === "sessions.patch" ? [request.key!] : request.targets!.map(({ key }) => key);
        for (const key of keys) {
          const row = Object.assign({}, mock.getSessionRow(key), { snapshotAt: Date.now() });
          const parent = Object.assign({}, mock.getSessionRow("agent:main:hidden-read-parent"), {
            snapshotAt: Date.now(),
          });
          emit("sessions.changed", {
            agentId: "main",
            reason: "patch",
            sessionKey: key,
            session: row,
            ancestorSessions: [parent],
          });
        }
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
        const parent = sessionRow(parentKey, "Parent with hidden runs", 20, {
          unread: false,
          childSessions: Array.from({ length: 150 }, (_, index) => runPrefix + index),
        });
        const other = sessionRow(otherKey, "Other thread", 10, { unread: false });
        const runs = Array.from({ length: 150 }, (_, index) =>
          sessionRow(runPrefix + index, "Hidden run " + index, 30, {
            parentSessionKey: parentKey,
            spawnedBy: parentKey,
            childOwnerSessionKeys: [parentKey],
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
        await expect
          .poll(() =>
            evaluateControlUiContext(
              page,
              ({ sessions }) =>
                sessions.state.result?.sessions.filter(
                  (row) =>
                    row.key.startsWith("agent:main:subagent:hidden-read-") && row.unread === false,
                ).length,
            ),
          )
          .toBe(150);
        const traffic = await page.evaluate(() => (window as TrafficWindow).hiddenRunReadTraffic);
        if (!traffic) {
          throw new Error("Hidden-run request probe was not installed");
        }
        const readRequests = async () => ({
          individual: (await gateway.getRequests("sessions.patch")).filter((request) =>
            String(support.requireRecord(request.params).key).startsWith(runPrefix),
          ),
          batch: (await gateway.getRequests("sessions.patchMany")).filter((request) =>
            (support.requireRecord(request.params).targets as { key: string }[]).some((target) =>
              target.key.startsWith(runPrefix),
            ),
          ),
        });
        const { individual, batch } = await readRequests();
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
        if (entry !== "organizer") {
          const rosterReads = (await gateway.getRequests("sessions.list")).filter(
            ({ params }) => !support.requireRecord(params).spawnedBy,
          ).length;
          expect(rosterReads).toBe(traffic.rosterReadsAtFirstAck);
        }
        if (entry === "reconnect") {
          const previousRevision = await evaluateControlUiContext(
            page,
            ({ sessions }) => sessions.canonicalListRevision,
          );
          await gateway.setOnline(false);
          await waitForControlUiGatewayReconnecting(page);
          await gateway.setOnline(true);
          await waitForControlUiGatewayReady(page);
          await expect
            .poll(() =>
              evaluateControlUiContext(
                page,
                ({ sessions }, previous) =>
                  sessions.canonicalListRevision > previous &&
                  !sessions.presentation.resultCached &&
                  sessions.presentation.result?.sessions.filter(
                    (row) =>
                      row.key.startsWith("agent:main:subagent:hidden-read-") &&
                      row.unread === false,
                  ).length === 150,
                previousRevision,
              ),
            )
            .toBe(true);
          await parentRow.click({ button: "right" });
          await page.getByRole("menuitem", { name: "Mark as unread", exact: true }).waitFor();
          await page.keyboard.press("Escape");
          const repeated = await page.evaluate(
            () => (window as TrafficWindow).hiddenRunReadTraffic,
          );
          expect(repeated).toMatchObject({
            completedTargets: 150,
            active: 0,
            peak: 1,
            batches: [100, 50],
          });
          const repeatedRequests = await readRequests();
          expect(repeatedRequests.individual).toHaveLength(0);
          expect(repeatedRequests.batch).toHaveLength(2);
        }
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
