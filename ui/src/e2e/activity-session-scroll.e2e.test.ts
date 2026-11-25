import path from "node:path";
import { expect, it } from "vitest";
import { waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { chatSessionListResponse, installMockGateway } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Activity reading position" });

suite.define(() => {
  it.each([1280, 390])(
    "keeps the reading row in place during live updates at %i px",
    async (width) => {
      await suite.withPage(
        { viewport: { width, height: 900 }, locale: "en-US" },
        async ({ page }) => {
          const now = new Date().setHours(12, 0, 0, 0);
          const sessions = Array.from({ length: 30 }, (_, index) => ({
            key: "agent:main:activity-scroll-" + index,
            sessionId: "activity-scroll-" + index,
            agentId: "main",
            kind: "direct" as const,
            label: "Review session " + (index + 1),
            updatedAt: now - index * 60_000,
            snapshotAt: now,
            activitySummary: {
              state: "current" as const,
              text: "Reviewing the proposed changes and checking the affected user flow.",
              updatedAt: now,
            },
          }));
          const gateway = await installMockGateway(page, {
            sessionKey: sessions[0]!.key,
            methodResponses: { "sessions.list": chatSessionListResponse(sessions) },
          });
          await page.goto(suite.server.baseUrl + "activity");
          await waitForControlUiRoute(page, { routeId: "activity", search: "" });
          const row = page.locator('[data-activity-session="' + sessions[8]!.key + '"]');
          await row.waitFor();
          // When nobody is scrolling, the newest session becomes visible automatically.
          await gateway.emitGatewayEvent("sessions.changed", {
            agentId: "main",
            reason: "patch",
            ancestorSessions: [],
            session: {
              ...sessions[6],
              updatedAt: now + 500,
              snapshotAt: now + 500,
              label: "Updated top session",
            },
          });
          await expect
            .poll(() =>
              page.locator('[data-activity-session="' + sessions[6]!.key + '"]').textContent(),
            )
            .toContain("Updated top session");
          expect(
            await page
              .locator("[data-activity-session]")
              .first()
              .getAttribute("data-activity-session"),
          ).toBe(sessions[6]!.key);
          await row.evaluate((element) => element.scrollIntoView({ block: "start" }));
          await page.evaluate(
            () =>
              new Promise<void>((resolve) => {
                requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
              }),
          );
          const before = await row.boundingBox();
          expect(before).not.toBeNull();
          await page.screenshot({
            path: path.join(suite.artifactDir, "reading-" + width + ".png"),
          });
          await gateway.emitGatewayEvent("sessions.changed", {
            agentId: "main",
            reason: "patch",
            ancestorSessions: [],
            session: {
              ...sessions[8],
              updatedAt: now + 1_000,
              snapshotAt: now + 1_000,
              label: "Updated reading session",
            },
          });
          await expect.poll(() => row.textContent()).toContain("Updated reading session");
          const after = await row.boundingBox();
          await page.screenshot({
            path: path.join(suite.artifactDir, "updated-" + width + ".png"),
          });
          expect(Math.abs(after!.y - before!.y)).toBeLessThan(1);

          // Rows above the reader may change height without moving the reading row.
          const recap =
            "The review is complete. The desktop layout, mobile navigation, and keyboard flow all preserve the session being read. Follow-up notes and screenshots are attached for the next reviewer. ".repeat(
              4,
            );
          await gateway.emitGatewayEvent("sessions.changed", {
            agentId: "main",
            reason: "patch",
            ancestorSessions: [],
            session: {
              ...sessions[0],
              snapshotAt: now + 2_000,
              activitySummary: { state: "current", text: recap, updatedAt: now + 2_000 },
            },
          });
          await expect
            .poll(() =>
              page.locator('[data-activity-recap="' + sessions[0]!.key + '"]').textContent(),
            )
            .toContain(recap.trim());
          await expect
            .poll(async () => Math.abs((await row.boundingBox())!.y - before!.y))
            .toBeLessThan(1);

          // Authoritative refreshes can admit new sessions, but not insert them under the reader.
          const newest = {
            ...sessions[0]!,
            key: "agent:main:new-activity",
            sessionId: "new-activity",
            label: "New arrival",
            updatedAt: now + 3_000,
            snapshotAt: now + 3_000,
          };
          const updated = {
            ...sessions[8]!,
            label: "Updated reading session",
            updatedAt: now + 1_000,
            snapshotAt: now + 1_000,
          };
          const refreshed = [newest, updated, ...sessions.filter((_, index) => index !== 8)];
          const initialReads = (await gateway.getRequests("sessions.list", { includePeople: true }))
            .length;
          await gateway.setSessionsListResponse(chatSessionListResponse(refreshed));
          await gateway.emitGatewayEvent("sessions.changed", {
            sessionKey: newest.key,
            reason: "create",
          });
          await expect
            .poll(
              async () =>
                (await gateway.getRequests("sessions.list", { includePeople: true })).length,
            )
            .toBeGreaterThan(initialReads);
          await expect
            .poll(() => page.locator(".activity-feed__footer").textContent())
            .toContain("30");
          expect(await page.locator('[data-activity-session="' + newest.key + '"]').count()).toBe(
            0,
          );
          expect(Math.abs((await row.boundingBox())!.y - before!.y)).toBeLessThan(1);

          const scroller = page.locator(width > 768 ? ".activity-feed__main" : "main.content");
          const firstKey = () =>
            page.locator("[data-activity-session]").first().getAttribute("data-activity-session");
          // Reaching the edge isn't a refresh command. Reverse direction before the
          // browser paints the next frame: pending rows must not have been adopted.
          const edgeKey = await scroller.evaluate(async (element) => {
            element.scrollTop = 0;
            await new Promise(requestAnimationFrame);
            const first = document
              .querySelector("[data-activity-session]")
              ?.getAttribute("data-activity-session");
            element.scrollTop = 100;
            return first;
          });
          expect(edgeKey).toBe(sessions[6]!.key);
          await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(100);
          await scroller.evaluate((element) => {
            element.scrollTop = 0;
          });
          await expect.poll(firstKey).toBe(newest.key);
          expect(await scroller.evaluate((element) => element.scrollTop)).toBe(0);
          await gateway.emitGatewayEvent("sessions.changed", {
            agentId: "main",
            reason: "patch",
            ancestorSessions: [],
            session: { ...sessions[10], updatedAt: now + 4_000, snapshotAt: now + 4_000 },
          });
          await expect.poll(firstKey).toBe(sessions[10]!.key);

          // A new filter must not inherit the previous reading window.
          await row.evaluate((element) => element.scrollIntoView({ block: "start" }));
          const match = {
            ...newest,
            key: "agent:main:filtered-match",
            sessionId: "filtered-match",
            label: "New filter match",
          };
          await gateway.setSessionsListResponse(
            chatSessionListResponse([match, ...sessions.slice(0, 18)]),
          );
          await page.getByRole("button", { name: "Last 24 hours", exact: true }).click();
          await expect.poll(() => page.locator("[data-activity-session]").count()).toBe(19);
          await expect
            .poll(() => page.locator("[data-activity-session]").first().textContent())
            .toContain("New filter match");
        },
      );
    },
  );
});
