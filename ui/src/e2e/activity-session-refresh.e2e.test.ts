import path from "node:path";
import type { ElementHandle, Page } from "playwright";
import { expect, it } from "vitest";
import {
  pauseVirtualClock,
  waitForControlUiRoute,
  type MockGatewayControls,
  type MockGatewayRequest,
} from "../test-helpers/control-ui-e2e.ts";
import {
  expectCount,
  expectText,
  scrollRemainder,
  setVisibility,
  showText,
} from "./activity-assertions.test-support.ts";
import {
  captureUiProof,
  chatSessionListResponse,
  installMockGateway,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Activity session refresh lifecycle" });
const historyRow = (key: string, label: string) => ({
  key,
  kind: "direct",
  label,
  updatedAt: Date.now(),
});
const historyList = (key: string, label: string) =>
  chatSessionListResponse([historyRow(key, label)]);
async function openHistory(page: Page, key: string, label: string) {
  const gateway = await installMockGateway(page, {
    sessionKey: key,
    methodResponses: { "sessions.list": historyList(key, label) },
  });
  await page.goto(`${suite.server.baseUrl}activity`);
  await waitForControlUiRoute(page, { routeId: "activity", search: "" });
  const row = page.locator(`[data-activity-session="${key}"]`);
  await expectText(row).toContain(label);
  return { gateway, row };
}

suite.define(() => {
  it.each(["current", "history"])(
    "updates %s from certified row events without refetching the list",
    async (view) => {
      await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
        const key = "agent:main:activity-row-delta";
        const session = {
          key,
          agentId: "main",
          sessionId: "activity-row-delta",
          kind: "direct" as const,
          label: "Initial current work",
          updatedAt: 100,
          snapshotAt: 100,
          hasActiveRun: true,
          activeRunIds: ["active-run"],
          status: "running",
        };
        const gateway = await installMockGateway(page, {
          sessionKey: key,
          methodResponses: { "sessions.list": chatSessionListResponse([session]) },
        });
        await page.goto(`${suite.server.baseUrl}activity${view === "current" ? "?view=live" : ""}`);
        const row =
          view === "current"
            ? page
                .getByRole("region", { name: "Active sessions", exact: true })
                .locator(`[data-session-key="${key}"]`)
            : page.locator(`[data-activity-session="${key}"]`);
        await expectText(row).toContain("Initial current work");
        await page.clock.install();
        await pauseVirtualClock(page);
        const match = view === "current" ? { activeOnly: true } : { includePeople: true };
        const initial = (await gateway.getRequests("sessions.list", match)).length;
        await gateway.emitGatewayEvent("sessions.changed", {
          agentId: "main",
          reason: "patch",
          ancestorSessions: [],
          session: { ...session, label: "Updated by row event", updatedAt: 200, snapshotAt: 200 },
        });
        await expectText(row).toContain("Updated by row event");
        await page.clock.runFor(59_999);
        expect((await gateway.getRequests("sessions.list", match)).length).toBe(initial);
      });
    },
  );

  it("loads only the requested initial person-filtered Activity route", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const key = "agent:main:activity-initial-route";
      const response = {
        ...historyList(key, "Requested Activity"),
        involvingProfileId: "profile-ada",
        people: [
          { identity: { type: "profile", id: "profile-ada" }, label: "Ada", sessionCount: 1 },
        ],
      };
      const gateway = await installMockGateway(page, {
        sessionKey: key,
        methodResponses: { "sessions.list": response },
      });
      await page.goto(`${suite.server.baseUrl}activity/profile-ada?q=alpha`);
      await waitForControlUiRoute(page, { routeId: "activity", search: "?q=alpha" });
      await expectText(page.locator(`[data-activity-session="${key}"]`)).toContain(
        "Requested Activity",
      );
      const requests = await gateway.getRequests("sessions.list", { includePeople: true });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        params: { search: "alpha", involvingProfileId: "profile-ada" },
      });
      await captureUiProof(suite, page, "initial-route", "person.png");
    });
  });

  it("preserves three pending Activity query intents and excludes superseded replies", async () => {
    const key = "agent:main:activity-query-aba";
    const response = (label: string) => historyList(key, label);
    let gateway: MockGatewayControls | undefined;
    let originalInput: ElementHandle | null = null;
    const submitted: MockGatewayRequest[] = [];
    let settled = 0;
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block" },
      async ({ page }) => {
        const { gateway: controls } = await openHistory(page, key, "Initial history");
        gateway = controls;
        const match = { includePeople: true };
        const initialRequests = (await controls.getRequests("sessions.list", match)).length;
        const search = page.locator('.activity-feed__search input[type="search"]');
        originalInput = await search.elementHandle();
        for (const query of ["alpha", "beta", "alpha"]) {
          const queryMatch = { ...match, search: query };
          const after = (await controls.getRequests("sessions.list", queryMatch)).length;
          await controls.deferNext("sessions.list", queryMatch);
          await search.fill(query);
          submitted.push(
            await controls.waitForRequest("sessions.list", { after, match: queryMatch }),
          );
          await waitForControlUiRoute(page, { routeId: "activity", search: `?q=${query}` });
          expect(
            await search.evaluate((input, original) => input === original, originalInput),
          ).toBe(true);
          expect(await search.evaluate((input) => document.activeElement === input)).toBe(true);
          expect(await search.inputValue()).toBe(query);
        }
        expect(new Set(submitted.map((request) => request.id)).size).toBe(3);
        await expectCount(page.locator("[data-activity-session]")).toBe(0);
        for (const label of ["Old alpha reply", "Retired beta reply"]) {
          await controls.resolveDeferred("sessions.list", response(label));
          settled += 1;
          await expectCount(page.locator('.activity-feed__loading[aria-busy="true"]')).toBe(1);
          expect(await page.locator("[data-activity-session]").count()).toBe(0);
        }
        await controls.resolveDeferred("sessions.list", response("Current alpha reply"));
        settled += 1;
        await expectText(page.locator(`[data-activity-session="${key}"]`)).toContain(
          "Current alpha reply",
        );
        expect(await page.locator('.activity-feed__loading[aria-busy="true"]').count()).toBe(0);
        expect((await controls.getRequests("sessions.list", match)).slice(initialRequests)).toEqual(
          submitted,
        );
      },
      async () => {
        if (gateway) {
          while (settled < submitted.length) {
            await gateway.resolveDeferred("sessions.list", response("Cleanup reply"));
            settled += 1;
          }
        }
        await originalInput?.dispose();
      },
    );
  });

  it("holds hidden Activity invalidations and catches up once before coalescing visible bursts", async () => {
    await suite.withPage(
      {
        viewport: { width: 1280, height: 900 },
        locale: "en-US",
        recordVideo: { dir: suite.artifactDir, size: { width: 1280, height: 900 } },
      },
      async ({ page }) => {
        const key = "agent:main:activity-refresh";
        const response = (label: string) => historyList(key, label);
        const { gateway, row } = await openHistory(page, key, "Initial activity");
        await page.screenshot({ path: path.join(suite.artifactDir, "01-initial.png") });
        const activityRequests = async () =>
          (await gateway.getRequests("sessions.list", { includePeople: true })).length;
        await page.clock.install();
        await pauseVirtualClock(page);
        const initialRequests = await activityRequests();
        await setVisibility(page, "hidden");
        await gateway.setSessionsListResponse(response("Caught up activity"));
        const burst = async (interval: number) => {
          for (let index = 0; index < 10; index += 1) {
            await gateway.emitGatewayEvent("sessions.changed", {
              sessionKey: key,
              reason: "update",
            });
            await page.clock.runFor(interval);
          }
        };
        await burst(50);
        expect(await activityRequests()).toBe(initialRequests);
        expect(await row.textContent()).toContain("Initial activity");

        await setVisibility(page, "visible", true);
        // Deliver the catch-up request and its nested mock response timer.
        await page.clock.runFor(1);
        await expectText(row).toContain("Caught up activity");
        expect(await activityRequests()).toBe(initialRequests + 1);
        await page.screenshot({ path: path.join(suite.artifactDir, "02-caught-up.png") });

        await gateway.setSessionsListResponse(response("Latest activity"));
        await burst(10);
        expect(await activityRequests()).toBe(initialRequests + 1);
        // The first visible event starts a five-second window; the burst consumed 100 ms.
        await page.clock.runFor(4_899);
        expect(await activityRequests()).toBe(initialRequests + 1);
        expect(await row.textContent()).toContain("Caught up activity");
        // Cross the event window and deliver the queued mock response.
        await page.clock.runFor(2);
        await expectText(row).toContain("Latest activity");
        expect(await activityRequests()).toBe(initialRequests + 2);
        await page.screenshot({ path: path.join(suite.artifactDir, "03-visible-burst.png") });
        await page.clock.resume();

        await gateway.setSessionsListResponse({
          ...response("Latest activity"),
          sessions: [
            {
              ...historyRow(key, "Latest activity"),
              hasActiveRun: true,
              status: "running",
            },
          ],
          hasMore: true,
          totalCount: 101,
        });
        const after = await gateway.deferNext("sessions.messages.subscribe", { key });
        await page.getByRole("tab", { name: "Live activity", exact: true }).click();
        await gateway.waitForRequest("sessions.messages.subscribe", { after, match: { key } });
        // Scoped events can be delivered only after the Gateway accepts the subscription.
        await gateway.resolveDeferred("sessions.messages.subscribe", undefined, { match: { key } });
        const emitTool = (data: object) =>
          gateway.emitGatewayEvent("agent", {
            runId: "run-activity",
            stream: "tool",
            sessionKey: key,
            data,
          });
        await emitTool({
          phase: "result",
          name: "exec",
          toolCallId: "tool-activity",
          result: { content: [{ type: "text", text: "Received while viewing Live activity." }] },
        });
        const entry = page.locator(".activity-entry");
        await expectCount(entry).toBe(1);
        await entry.locator("summary").click();
        await showText(entry, "Received while viewing Live activity.");
        await page.screenshot({ path: path.join(suite.artifactDir, "04-live-activity.png") });
        for (let index = 0; index < 20; index += 1) {
          await emitTool({ phase: "start", name: "exec", toolCallId: `tool-${index}` });
        }
        const stream = page.locator(".activity-stream");
        await expect
          .poll(() =>
            stream.evaluate((element) => element.scrollHeight > element.clientHeight + 120),
          )
          .toBe(true);
        const autoFollow = page.locator(".activity-live-autofollow").getByRole("switch");
        await autoFollow.click();
        await stream.evaluate((element) => {
          element.scrollTop = 0;
          element.dispatchEvent(new Event("scroll"));
        });
        await autoFollow.click();
        await page.clock.runFor(100);
        await expect.poll(() => scrollRemainder(stream)).toBeLessThanOrEqual(1);
        const current = page.getByRole("region", { name: "Active sessions", exact: true });
        await showText(current.locator(`[data-session-key="${key}"]`), "Latest activity");
        await showText(current, "Showing 1 of 101 active sessions.");
        await expect
          .poll(() =>
            current.evaluate((element) => {
              const clip = element
                .querySelector(".activity-current-work__rows")
                ?.getBoundingClientRect();
              const content = element
                .querySelector(".activity-current-work__feedback")
                ?.getBoundingClientRect();
              return Boolean(
                clip &&
                content &&
                content.height > 0 &&
                content.top >= clip.top - 1 &&
                content.bottom <= clip.bottom + 1,
              );
            }),
          )
          .toBe(true);
        await page.screenshot({ path: path.join(suite.artifactDir, "05-live-burst.png") });
        await page.getByRole("tab", { name: "Sessions", exact: true }).click();
        await expectText(row).toContain("Latest activity");
      },
    );
  });
});
