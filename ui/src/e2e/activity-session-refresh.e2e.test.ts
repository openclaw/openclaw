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
  setVisibility,
  showText,
} from "./activity-assertions.test-support.ts";
import {
  captureUiProof,
  chatSessionListResponse,
  installMockGateway,
  requireRecord,
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

function titleSearchControls(page: Page) {
  const field = page.getByRole("searchbox", { name: "Search session titles…" });
  const expectBookmark = async (search: string, value: string, pathname = "/openclaw/activity") => {
    await waitForControlUiRoute(page, {
      routeId: "activity",
      pathname,
      search,
    });
    await expect.poll(() => field.inputValue()).toBe(value);
  };
  const expectIds = async (keys: string[]) => {
    const visible = page.locator("[data-activity-session]");
    await expect
      .poll(() =>
        visible.evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute("data-activity-session")),
        ),
      )
      .toEqual(keys);
  };
  return { expectBookmark, expectIds, field };
}

async function openTitleSearch(page: Page) {
  const rows = [
    historyRow("agent:main:spaced-title", "A B"),
    historyRow("agent:main:interior-title", "string"),
  ];
  const gateway = await installMockGateway(
    page,
    { basePath: "/openclaw" },
    {
      requestHandlers: {
        "sessions.list": (params) => {
          const { search = "" } = requireRecord(params);
          return chatSessionListResponse(
            rows.filter((row) => typeof search === "string" && row.label.includes(search)),
          );
        },
      },
    },
  );
  await page.goto(`${suite.server.baseUrl}openclaw/activity`);
  return { ...titleSearchControls(page), gateway };
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

  it("preserves a typed session title separator across Activity history", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const key = "agent:main:spaced-title";
      const title = "A B";
      const { expectBookmark, expectIds, field, gateway } = await openTitleSearch(page);
      await field.pressSequentially("A");
      await expectBookmark("?q=A", "A");
      const feed = { includePeople: true };
      const firstRead = await gateway.waitForRequest("sessions.list", {
        match: { ...feed, search: "A", activeMinutes: 10080 },
      });
      const throughFirstRead = (await gateway.getRequests("sessions.list", feed)).length;
      await expectIds([key]);

      await field.press("Space");
      await expectBookmark("?q=A+", "A ");
      expect(await field.evaluate((input: HTMLInputElement) => input.selectionStart)).toBe(2);
      const atSeparator = await gateway.getRequests("sessions.list", feed);
      // A pending route can clear the feed owner and reissue the same committed filter.
      for (const read of atSeparator.slice(throughFirstRead)) {
        expect(read.params).toEqual(firstRead.params);
      }
      await expectIds([key]);
      await page.goBack();
      await expectBookmark("?q=A", "A");
      await page.goForward();
      await expectBookmark("?q=A+", "A ");
      expect(await gateway.getRequests("sessions.list", feed)).toEqual(atSeparator);
      await expectIds([key]);

      const month = page.getByRole("button", { name: "Last 30 days", exact: true });
      await month.click();
      await expectBookmark("?time=30d&q=A+", "A ");
      await gateway.waitForRequest("sessions.list", {
        match: { ...feed, search: "A", activeMinutes: 43200 },
      });
      await month.click();
      await page.goBack();
      await expectBookmark("?q=A+", "A ");
      await page.goForward();
      await expectBookmark("?time=30d&q=A+", "A ");
      // Resume editing at the end of the field after using the window selector.
      await field.focus();
      const caret = await field.evaluate((input: HTMLInputElement) => {
        input.setSelectionRange(input.value.length, input.value.length);
        return [document.activeElement === input, input.selectionStart, input.selectionEnd];
      });
      expect(caret).toEqual([true, 2, 2]);
      await page.keyboard.type("B");
      await expectBookmark("?time=30d&q=A+B", title);
      await expectIds([key]);

      await page.reload();
      await expectBookmark("?time=30d&q=A+B", title);
      await gateway.waitForRequest("sessions.list", {
        match: { ...feed, search: title, activeMinutes: 43200 },
      });
      await expectIds([key]);

      await field.fill("AB");
      await expectBookmark("?time=30d&q=AB", "AB");
      await expectIds([]);
      await field.press("ArrowLeft");
      await field.press("Space");
      await expectBookmark("?time=30d&q=A+B", title);
      expect(await field.evaluate((input: HTMLInputElement) => input.selectionStart)).toBe(2);
      await field.fill("");
      await expectBookmark("?time=30d", "");
      await page.keyboard.insertText(title);
      await expectBookmark("?time=30d&q=A+B", title);
      await expectIds([key]);
    });
  });

  it.each(["select", "everyone", "clear"] as const)(
    "keeps the editable title when People changes via %s",
    async (action) => {
      await suite.withPage(
        { viewport: { width: 1280, height: 900 }, serviceWorkers: "block", locale: "en-US" },
        async ({ page }) => {
          const activityPath = "/openclaw/activity";
          const person = "profile-ada";
          const selected = action === "select";
          const initialPath = selected ? activityPath : `${activityPath}/${person}`;
          const nextPath = selected ? `${activityPath}/${person}` : activityPath;
          const mine = historyRow("agent:main:ada-title", "A B");
          const other = {
            ...historyRow("agent:main:other-title", "A B elsewhere"),
            updatedAt: mine.updatedAt - 1_000,
          };
          const gateway = await installMockGateway(
            page,
            { basePath: "/openclaw" },
            {
              requestHandlers: {
                "sessions.list": (params) => {
                  const { search = "", involvingProfileId } = requireRecord(params);
                  const scoped = involvingProfileId === person ? [mine] : [mine, other];
                  return {
                    ...chatSessionListResponse(
                      scoped.filter(
                        (row) => typeof search === "string" && row.label.includes(search),
                      ),
                    ),
                    ...(involvingProfileId === person ? { involvingProfileId: person } : {}),
                    people: [
                      { identity: { type: "profile", id: person }, label: "Ada", sessionCount: 1 },
                    ],
                  };
                },
              },
            },
          );
          const { expectBookmark, expectIds, field } = titleSearchControls(page);
          await page.goto(new URL(initialPath + "?time=30d", suite.server.baseUrl).href);
          await expectBookmark("?time=30d", "", initialPath);
          await field.pressSequentially("A");
          await expectBookmark("?time=30d&q=A", "A", initialPath);
          await field.press("Space");
          await expectBookmark("?time=30d&q=A+", "A ", initialPath);

          const feed = { includePeople: true, activeMinutes: 43200 };
          await expectIds(selected ? [mine.key, other.key] : [mine.key]);
          const before = (await gateway.getRequests("sessions.list", feed)).length;
          if (action === "clear") {
            await page.getByRole("button", { name: "Clear person filter", exact: true }).click();
          } else {
            await page
              .getByRole("button", { name: "Filter sessions by person", exact: true })
              .click();
            await page.locator(`[data-activity-person="${selected ? person : ""}"]`).click();
          }
          await waitForControlUiRoute(page, { routeId: "activity", pathname: nextPath });
          const ids = selected ? [mine.key] : [mine.key, other.key];
          await expectIds(ids);
          const switched = await gateway.waitForRequest("sessions.list", {
            after: before,
            match: feed,
          });
          const scoped = requireRecord(switched.params);
          expect(scoped.involvingProfileId).toBe(selected ? person : undefined);
          expect(scoped.search).toBe("A");
          const bookmark = new URL(page.url()).search;
          const draft = await field.inputValue();

          // The picker returns focus to its trigger. Resume at the end of the actual draft.
          await field.focus();
          const caret = await field.evaluate((input: HTMLInputElement) => {
            input.setSelectionRange(input.value.length, input.value.length);
            return [document.activeElement === input, input.selectionStart, input.selectionEnd];
          });
          await page.keyboard.type("B");
          const typed = draft + "B";
          const search = "?" + new URLSearchParams({ time: "30d", q: typed }).toString();
          await expectBookmark(search, typed, nextPath);
          const match = { ...feed, search: typed };
          const warm = await gateway.waitForRequest("sessions.list", { match });
          const deliveredIds = typed === "A B" ? ids : [];
          await expectIds(deliveredIds);
          await page.reload();
          await expectBookmark(search, typed, nextPath);
          const cold = await gateway.waitForRequest("sessions.list", { match });
          await expectIds(deliveredIds);
          const expectedRequest = ["A B", selected ? person : undefined];
          expect({
            bookmark,
            draft,
            caret,
            typed,
            requests: [warm, cold].map((read) => {
              const params = requireRecord(read.params);
              return [params.search, params.involvingProfileId];
            }),
          }).toEqual({
            bookmark: "?time=30d&q=A+",
            draft: "A ",
            caret: [true, 2, 2],
            typed: "A B",
            requests: [expectedRequest, expectedRequest],
          });
          await expectIds(ids);
        },
      );
    },
  );

  it("keeps the insertion point between consecutive interior title edits", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const { expectBookmark, expectIds, field, gateway } = await openTitleSearch(page);
      const expectedIds = ["agent:main:interior-title"];
      await field.fill("sing");
      await expectBookmark("?q=sing", "sing");
      const feed = { includePeople: true };
      await gateway.waitForRequest("sessions.list", { match: { ...feed, search: "sing" } });
      await expectIds([]);
      const beforeEdits = (await gateway.getRequests("sessions.list", feed)).length;
      await field.focus();
      const original = await field.elementHandle();
      const expectCaret = async (position: number) => {
        expect(
          await field.evaluate(
            (input: HTMLInputElement, initial) => [
              input === initial,
              input === document.activeElement,
              input.selectionStart,
              input.selectionEnd,
            ],
            original,
          ),
        ).toEqual([true, true, position, position]);
      };
      try {
        await field.evaluate((input: HTMLInputElement) => input.setSelectionRange(1, 1));
        await expectCaret(1);
        await page.keyboard.type("t");
        await expectBookmark("?q=sting", "sting");
        await expectCaret(2);
        await page.keyboard.type("r");
        await expectBookmark("?q=string", "string");
        await expectCaret(3);
      } finally {
        await original?.dispose();
      }
      await gateway.waitForRequest("sessions.list", { match: { ...feed, search: "string" } });
      const editReads = (await gateway.getRequests("sessions.list", feed)).slice(beforeEdits);
      expect(new Set(editReads.map((read) => requireRecord(read.params).search))).toEqual(
        new Set(["sting", "string"]),
      );
      await expectIds(expectedIds);
      await page.reload();
      await expectBookmark("?q=string", "string");
      await expectIds(expectedIds);
      await field.fill("");
      await expectBookmark("", "");
      await page.keyboard.insertText("string");
      await expectBookmark("?q=string", "string");
      await expectIds(expectedIds);
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
        recordVideo:
          process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
            ? { dir: suite.artifactDir, size: { width: 1280, height: 900 } }
            : undefined,
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
        await page.getByRole("tab", { name: "Current work", exact: true }).click();
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
