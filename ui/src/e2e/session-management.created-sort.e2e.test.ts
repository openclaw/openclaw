import { expect, it } from "vitest";
import { pauseVirtualClock } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import * as ui from "./session-management.compact.test-support.ts";
import * as support from "./session-management.test-support.ts";

const suite = support.createSessionManagementE2eSuite();

suite.define(() =>
  it("keeps externally discovered newest sessions above Show more", () =>
    ui.withSessionPage(
      suite,
      async (page) => {
        const baseTime = Date.parse("2026-08-14T18:00:00.000Z");
        const createdRow = (key: string, label: string, createdAt: number) => ({
          ...sessionRow(key, label, createdAt),
          createdAt,
        });
        const olderRows = Array.from({ length: 10 }, (_, i) =>
          createdRow(`agent:main:older-${i}`, `Older session ${i}`, baseTime - i * 1_000),
        );
        const newestKey = "agent:main:external-new";
        const newestRow = createdRow(newestKey, "External newest", baseTime + 1_000);
        // Sticky membership preserves the full prior page when a newer session enters.
        const expectedVisibleKeys = [newestKey, ...olderRows.map((row) => row.key)];
        const gateway = await ui.installSessionRows(page, olderRows, {
          sessionKey: olderRows[0]?.key,
        });

        await page.goto(support.controlUiSessionUrl(suite.server.baseUrl, olderRows[0]!.key));
        const rows = page.locator(".sidebar-recent-session");
        await expect.poll(() => rows.count(), { timeout: 10_000 }).toBe(10);
        const retainedSessionKey = olderRows[5]!.key;
        await rows.nth(5).evaluate((row) => Reflect.set(row, "__retainedSessionRow", true));
        await support.captureUiProof(suite, page, "sidebar-created-sort-before-refresh.png");
        const initialListCount = (await gateway.getRequests("sessions.list")).length;

        await page.clock.install();
        await pauseVirtualClock(page);

        await gateway.setSessionsListResponse(
          support.sessionsListResponse([...olderRows, newestRow]),
        );
        await gateway.emitGatewayEvent("sessions.changed", {
          key: newestKey,
          kind: "direct",
          reason: "create",
          sessionKey: newestKey,
          updatedAt: newestRow.updatedAt,
        });
        // Cross the full refresh window and deliver its nested mock response timer.
        await page.clock.runFor(5_001);
        await expect
          .poll(() => ui.requestCount(gateway, "sessions.list"))
          .toBeGreaterThan(initialListCount);
        await page.clock.resume();
        await expect
          .poll(() =>
            rows.evaluateAll((elements) =>
              elements.map((element) => element.getAttribute("data-session-key")),
            ),
          )
          .toEqual(expectedVisibleKeys);
        const retained = ui.sessionRows(page)(retainedSessionKey);
        expect(await retained.evaluate((row) => Reflect.get(row, "__retainedSessionRow"))).toBe(
          true,
        );
        await support.captureUiProof(suite, page, "sidebar-created-sort-after-refresh.png");
      },
      {},
      "sidebar-created-sort-external-session.webm",
    )),
);
